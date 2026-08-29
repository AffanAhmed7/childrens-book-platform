import { Resend } from "resend";
import { env } from "../env";

// Same construction-time-throw issue as stripeClient.ts: Resend's constructor
// throws on an empty/missing key rather than deferring to call time, so an
// empty-string fallback would crash the whole server at boot.
const resend = new Resend(env.RESEND_API_KEY ?? "re_unconfigured");

// Matches the promise made in the /confirmation page and the reference site's
// own trust-section wording. Keep these two copies in sync if either changes —
// see the frontend plan's confirmation page task.
const GDPR_DELETION_NOTICE =
  "Your uploaded photos are automatically deleted within 24 hours of your order being marked delivered.";

interface OrderForEmail {
  id: string;
  email: string;
  totalCents: number;
  currency: string;
  items: { bookTitle: string }[];
}

function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat("en", { style: "currency", currency }).format(cents / 100);
}

export async function sendOrderConfirmationEmail(order: OrderForEmail): Promise<void> {
  const bookList = order.items.map((item) => `- ${item.bookTitle}`).join("\n");
  const total = formatMoney(order.totalCents, order.currency);

  await resend.emails.send({
    from: env.RESEND_FROM_ADDRESS,
    to: order.email,
    subject: `Your order ${order.id} is confirmed`,
    text:
      `Thank you for your order!\n\n` +
      `Order ID: ${order.id}\n` +
      `Books:\n${bookList}\n` +
      `Total: ${total}\n\n` +
      `Estimated delivery: 7-10 business days after printing.\n\n` +
      `${GDPR_DELETION_NOTICE}\n\n` +
      `Track your order any time at /track/${order.id} — no login required.`,
  });
}
