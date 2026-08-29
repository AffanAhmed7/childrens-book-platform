import { prisma } from "./db";
import { getPipelineQueue, getPipelineQueueEvents } from "./queue";
import { assembleItemPdf } from "./print/assemble";
import { submitOrderToGelato } from "./print/gelato";
import { sendOrderConfirmationEmail } from "./email/orderConfirmation";
import { ORDER_STATUS } from "./orderStatus";

// A full book can have several pages, each up to a few minutes (see
// pipeline/catalog.ts's estimateSeconds); generous but bounded so a genuinely
// stuck render surfaces as a failed order instead of hanging forever.
const FULL_RENDER_TIMEOUT_MS = 15 * 60_000;

async function appendStatusEvent(
  orderId: string,
  status: string,
  source: "system" | "stripe_webhook" | "gelato_webhook",
  raw?: unknown,
): Promise<void> {
  await prisma.orderStatusEvent.create({
    data: { orderId, status, source, raw: raw === undefined ? undefined : (raw as object) },
  });
}

async function renderEveryItem(items: { sessionId: string }[]): Promise<void> {
  const queue = getPipelineQueue();
  const queueEvents = getPipelineQueueEvents();
  await Promise.all(
    items.map(async ({ sessionId }) => {
      // Same dedup jobId convention as the existing render-full route: if the
      // preview already rendered every page (or a prior fulfillment attempt got
      // partway through), this either no-ops or is deduped by BullMQ itself.
      const job = await queue.add(
        "process",
        { sessionId, mode: "full" },
        { attempts: 1, removeOnComplete: { count: 1000, age: 3600 }, removeOnFail: 100, jobId: `${sessionId}__full` },
      );
      await job.waitUntilFinished(queueEvents, FULL_RENDER_TIMEOUT_MS);
    }),
  );
}

/**
 * Runs after a Stripe webhook marks an order paid. Fire-and-forget from the
 * webhook handler's perspective (it already returned 200 to Stripe) — any
 * failure here marks the order "failed" with an audit event rather than
 * throwing into the void.
 */
export async function runFulfillment(orderId: string): Promise<void> {
  try {
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } });

    await renderEveryItem(order.items);

    for (const item of order.items) {
      const printPageKeys = item.printPageKeys as string[];
      const { key } = await assembleItemPdf(order.id, { id: item.id, printPageKeys });
      await prisma.orderItem.update({ where: { id: item.id }, data: { printPdfKey: key } });
    }
    await prisma.order.update({ where: { id: order.id }, data: { status: ORDER_STATUS.pdfReady } });
    await appendStatusEvent(order.id, ORDER_STATUS.pdfReady, "system");

    const itemsWithPdf = await prisma.orderItem.findMany({ where: { orderId: order.id } });
    const { gelatoOrderId } = await submitOrderToGelato({
      id: order.id,
      shippingName: order.shippingName,
      shippingLine1: order.shippingLine1,
      shippingLine2: order.shippingLine2,
      shippingCity: order.shippingCity,
      shippingPostalCode: order.shippingPostalCode,
      shippingCountry: order.shippingCountry,
      items: itemsWithPdf.map((i) => ({ id: i.id, bookTitle: i.bookTitle, printPdfKey: i.printPdfKey! })),
    });
    await prisma.order.update({
      where: { id: order.id },
      data: { status: ORDER_STATUS.submittedToPrint, gelatoOrderId },
    });
    await appendStatusEvent(order.id, ORDER_STATUS.submittedToPrint, "system", { gelatoOrderId });

    await sendOrderConfirmationEmail({
      id: order.id,
      email: order.email,
      totalCents: order.totalCents,
      currency: order.currency,
      items: itemsWithPdf.map((i) => ({ bookTitle: i.bookTitle })),
    });
  } catch (error) {
    console.error(`[fulfillment] order ${orderId} FAILED:`, error);
    await prisma.order.update({ where: { id: orderId }, data: { status: ORDER_STATUS.failed } });
    await appendStatusEvent(orderId, ORDER_STATUS.failed, "system", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
