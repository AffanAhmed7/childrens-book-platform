"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { addSessionToCart, getCartSessionIds, removeSessionFromCart } from "@/lib/cart";
import { apiGet } from "@/lib/api";
import { BOOK_PRICES_CENTS, formatMoney } from "@/lib/pricing";

interface SessionPagesResponse {
  sessionId: string;
  storyId: string;
  title: string;
  pages: { id: string; url: string | null }[];
}

function CartPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [items, setItems] = useState<SessionPagesResponse[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const addId = searchParams.get("add");
    if (addId) {
      addSessionToCart(addId);
      router.replace("/cart");
    }
  }, [searchParams, router]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      const ids = getCartSessionIds();
      const results = await Promise.all(
        ids.map((id) => apiGet<SessionPagesResponse>(`/api/sessions/${id}/pages`).catch(() => null)),
      );
      if (!cancelled) {
        setItems(results.filter((r): r is SessionPagesResponse => r !== null));
        setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [searchParams]);

  const handleRemove = (sessionId: string) => {
    removeSessionFromCart(sessionId);
    setItems((prev) => prev.filter((i) => i.sessionId !== sessionId));
  };

  const totalCents = items.reduce((sum, item) => sum + (BOOK_PRICES_CENTS[item.storyId] ?? 0), 0);

  if (loading) return <main className="max-w-2xl mx-auto p-8">Loading your cart…</main>;

  return (
    <main className="max-w-2xl mx-auto p-8">
      <h1 className="font-serif text-3xl mb-6">Your cart</h1>
      {items.length === 0 ? (
        <>
          <p className="mb-6">Your cart is empty for now.</p>
          <Link href="/" className="rounded-full bg-green-700 text-white px-6 py-3 font-medium">
            Browse the stories
          </Link>
        </>
      ) : (
        <>
          <ul className="space-y-4">
            {items.map((item) => (
              <li key={item.sessionId} className="flex items-center justify-between border rounded-xl p-4">
                <div>
                  <p className="font-medium">{item.title}</p>
                  <p className="text-sm text-gray-600">{formatMoney(BOOK_PRICES_CENTS[item.storyId] ?? 0)}</p>
                </div>
                <button onClick={() => handleRemove(item.sessionId)} className="text-sm underline">
                  Remove
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-6 flex items-center justify-between">
            <p className="font-medium">Total: {formatMoney(totalCents)}</p>
            <Link href="/checkout" className="rounded-full bg-green-700 text-white px-6 py-3 font-medium">
              Proceed to checkout →
            </Link>
          </div>
        </>
      )}
    </main>
  );
}

export default function CartPage() {
  return (
    <Suspense fallback={<main className="max-w-2xl mx-auto p-8">Loading…</main>}>
      <CartPageInner />
    </Suspense>
  );
}
