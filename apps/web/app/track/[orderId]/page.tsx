import { API_BASE_URL } from "@/lib/api";
import { formatMoney } from "@/lib/pricing";

interface OrderView {
  id: string;
  status: string;
  totalCents: number;
  currency: string;
  items: { id: string; bookTitle: string; priceCents: number }[];
  statusEvents: { status: string; source: string; createdAt: string }[];
}

async function getOrder(orderId: string): Promise<OrderView | null> {
  const res = await fetch(`${API_BASE_URL}/api/orders/${orderId}`, { cache: "no-store" });
  if (!res.ok) return null;
  return res.json();
}

export default async function TrackOrderPage({ params }: { params: { orderId: string } }) {
  const order = await getOrder(params.orderId);
  if (!order) {
    return (
      <main className="page page--narrow">
        <p className="eyebrow">Order tracking</p>
        <h1 className="page-title">We couldn't find that order</h1>
        <p className="page-lede">Double-check the link, or the order ID from your confirmation email.</p>
      </main>
    );
  }

  return (
    <main className="page page--narrow">
      <p className="eyebrow">Order tracking</p>
      <h1 className="page-title">{order.status.replace(/_/g, " ")}</h1>
      <p className="page-lede">Order <span className="mono-id">{order.id}</span></p>

      <div className="card checkout-panel" style={{ marginBottom: 28 }}>
        <ul className="checkout-summary__list">
          {order.items.map((item) => (
            <li key={item.id}>
              <span>{item.bookTitle}</span>
              <span>{formatMoney(item.priceCents, order.currency)}</span>
            </li>
          ))}
        </ul>
      </div>

      <p className="eyebrow">Status history</p>
      <ol className="track-timeline">
        {order.statusEvents.length === 0 && (
          <li className="track-timeline__item">
            <p className="track-timeline__status">Awaiting payment confirmation</p>
          </li>
        )}
        {order.statusEvents.map((event, i) => (
          <li key={i} className="track-timeline__item">
            <p className="track-timeline__status">{event.status.replace(/_/g, " ")}</p>
            <p className="track-timeline__time">{new Date(event.createdAt).toLocaleString()}</p>
          </li>
        ))}
      </ol>
    </main>
  );
}
