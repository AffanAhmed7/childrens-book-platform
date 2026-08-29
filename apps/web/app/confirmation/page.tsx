"use client";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { apiGet } from "@/lib/api";
import { formatMoney } from "@/lib/pricing";
import { clearCart } from "@/lib/cart";

interface OrderView {
  id: string;
  status: string;
  totalCents: number;
  currency: string;
  items: { id: string; bookTitle: string; priceCents: number }[];
}

function ConfirmationInner() {
  const searchParams = useSearchParams();
  const orderId = searchParams.get("order");
  const [order, setOrder] = useState<OrderView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!orderId) return;
    clearCart();
    apiGet<OrderView>(`/api/orders/${orderId}`)
      .then(setOrder)
      .catch(() => setError("We couldn't find that order."));
  }, [orderId]);

  if (!orderId) return <main className="max-w-2xl mx-auto p-8">No order specified.</main>;
  if (error) return <main className="max-w-2xl mx-auto p-8">{error}</main>;
  if (!order) return <main className="max-w-2xl mx-auto p-8">Loading your order…</main>;

  return (
    <main className="max-w-2xl mx-auto p-8">
      <h1 className="font-serif text-3xl mb-2">Order confirmed!</h1>
      <p className="text-gray-600 mb-6">Order ID: {order.id}</p>
      <ul className="space-y-2 mb-6">
        {order.items.map((item) => (
          <li key={item.id} className="flex justify-between">
            <span>{item.bookTitle}</span>
            <span>{formatMoney(item.priceCents, order.currency)}</span>
          </li>
        ))}
      </ul>
      <p className="font-medium mb-8">Total: {formatMoney(order.totalCents, order.currency)}</p>
      <div className="rounded-xl border p-4 mb-8">
        <p className="font-medium mb-1">Your data, protected by design</p>
        <p className="text-sm text-gray-600">
          Your uploaded photos are automatically deleted within 24 hours of your order being
          marked delivered.
        </p>
      </div>
      <Link href={`/track/${order.id}`} className="rounded-full bg-green-700 text-white px-6 py-3 font-medium">
        Track your order →
      </Link>
    </main>
  );
}

export default function ConfirmationPage() {
  return (
    <Suspense fallback={<main className="max-w-2xl mx-auto p-8">Loading…</main>}>
      <ConfirmationInner />
    </Suspense>
  );
}
