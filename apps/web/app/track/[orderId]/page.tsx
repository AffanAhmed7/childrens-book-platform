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
    return <main className="max-w-2xl mx-auto p-8">Order not found.</main>;
  }

  return (
    <main className="max-w-2xl mx-auto p-8">
      <h1 className="font-serif text-3xl mb-2">Track your order</h1>
      <p className="text-gray-600 mb-6">
        Order ID: {order.id} · Status: {order.status.replace(/_/g, " ")}
      </p>
      <ul className="space-y-2 mb-8">
        {order.items.map((item) => (
          <li key={item.id} className="flex justify-between">
            <span>{item.bookTitle}</span>
            <span>{formatMoney(item.priceCents, order.currency)}</span>
          </li>
        ))}
      </ul>
      <h2 className="font-medium mb-3">Status history</h2>
      <ol className="space-y-3 border-l-2 border-green-700 pl-4">
        {order.statusEvents.length === 0 && (
          <li className="text-gray-600">Awaiting payment confirmation.</li>
        )}
        {order.statusEvents.map((event, i) => (
          <li key={i}>
            <p className="font-medium">{event.status.replace(/_/g, " ")}</p>
            <p className="text-sm text-gray-600">{new Date(event.createdAt).toLocaleString()}</p>
          </li>
        ))}
      </ol>
    </main>
  );
}
