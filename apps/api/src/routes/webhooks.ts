import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { prisma } from "../db";
import { env } from "../env";
import { stripe } from "../stripeClient";
import { canTransitionToPaid, mapGelatoStatus, ORDER_STATUS, type OrderStatus } from "../orderStatus";
import { runFulfillment } from "../fulfillment";

/**
 * Its own encapsulated plugin (registered via app.register, not called
 * directly like registerSessionRoutes) so the raw-body content-type parser
 * below applies ONLY to these two routes — Fastify plugin encapsulation means
 * every other route keeps normal JSON parsing.
 */
export async function registerWebhookRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => {
    done(null, body);
  });

  app.post("/api/webhooks/stripe", async (request, reply) => {
    const signature = request.headers["stripe-signature"];
    if (typeof signature !== "string") {
      return reply.code(400).send({ message: "Missing stripe-signature header." });
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        request.body as Buffer,
        signature,
        env.STRIPE_WEBHOOK_SECRET ?? "",
      );
    } catch (error) {
      request.log.error({ error }, "Stripe webhook signature verification failed");
      return reply.code(400).send({ message: "Invalid signature." });
    }

    if (event.type === "payment_intent.succeeded") {
      const paymentIntent = event.data.object as { id: string };
      const order = await prisma.order.findUnique({ where: { stripePaymentIntentId: paymentIntent.id } });
      if (!order) {
        request.log.warn(`Stripe webhook for unknown PaymentIntent ${paymentIntent.id}`);
        return reply.code(200).send({ received: true });
      }
      // Prisma models order.status as a plain string column (not a native
      // Postgres enum), so this cast is the same "we own the vocabulary, the
      // DB doesn't enforce it" trust already implicit in ORDER_STATUS itself.
      if (canTransitionToPaid(order.status as OrderStatus)) {
        await prisma.order.update({ where: { id: order.id }, data: { status: ORDER_STATUS.paid } });
        await prisma.orderStatusEvent.create({
          data: { orderId: order.id, status: ORDER_STATUS.paid, source: "stripe_webhook", raw: event as object },
        });
        // Fire-and-forget: Stripe expects a fast response, not a wait for
        // rendering + PDF assembly + Gelato dispatch (minutes, not seconds).
        void runFulfillment(order.id);
      }
    }

    return reply.code(200).send({ received: true });
  });

  app.post("/api/webhooks/gelato", async (request, reply) => {
    if (env.GELATO_WEBHOOK_SECRET) {
      const providedSecret = request.headers["x-gelato-webhook-secret"];
      if (providedSecret !== env.GELATO_WEBHOOK_SECRET) {
        return reply.code(401).send({ message: "Invalid webhook secret." });
      }
    }

    const payload = JSON.parse((request.body as Buffer).toString("utf-8")) as {
      orderReferenceId?: string;
      status?: string;
    };
    const { orderReferenceId, status } = payload;
    if (!orderReferenceId || !status) {
      return reply.code(400).send({ message: "Missing orderReferenceId or status." });
    }

    const mapped = mapGelatoStatus(status);
    await prisma.orderStatusEvent.create({
      data: {
        orderId: orderReferenceId,
        status: mapped ?? status,
        source: "gelato_webhook",
        raw: payload,
      },
    });
    if (mapped) {
      await prisma.order.update({ where: { id: orderReferenceId }, data: { status: mapped } });
    } else {
      request.log.warn(`Unrecognized Gelato status "${status}" for order ${orderReferenceId} — stored raw, order.status left unchanged.`);
    }

    return reply.code(200).send({ received: true });
  });
}
