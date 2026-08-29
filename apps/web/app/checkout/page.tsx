"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import { getCartSessionIds } from "@/lib/cart";
import { apiPost } from "@/lib/api";

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? "");

interface CheckoutResponse {
  orderId: string;
  clientSecret: string;
}

function PaymentStep({ orderId }: { orderId: string }) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handlePay = async () => {
    if (!stripe || !elements) return;
    setSubmitting(true);
    setError(null);
    const { error: confirmError } = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: `${window.location.origin}/confirmation?order=${orderId}` },
    });
    if (confirmError) {
      setError(confirmError.message ?? "Payment failed.");
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      <PaymentElement />
      {error && <p className="text-red-600 text-sm">{error}</p>}
      <button
        onClick={handlePay}
        disabled={submitting}
        className="w-full rounded-full bg-green-700 text-white py-3 font-medium disabled:opacity-50"
      >
        {submitting ? "Processing…" : "Pay now"}
      </button>
    </div>
  );
}

export default function CheckoutPage() {
  const router = useRouter();
  const [checkout, setCheckout] = useState<CheckoutResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    email: "",
    name: "",
    line1: "",
    line2: "",
    city: "",
    postalCode: "",
    country: "FR",
  });
  const [gdprConsent, setGdprConsent] = useState(false);

  const handleContinue = async () => {
    const sessionIds = getCartSessionIds();
    if (sessionIds.length === 0) {
      router.push("/cart");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await apiPost<CheckoutResponse>("/api/checkout", {
        sessionIds,
        email: form.email,
        shippingAddress: {
          name: form.name,
          line1: form.line1,
          line2: form.line2 || undefined,
          city: form.city,
          postalCode: form.postalCode,
          country: form.country,
        },
        gdprConsent: true,
      });
      setCheckout(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Checkout failed.");
    } finally {
      setSubmitting(false);
    }
  };

  if (checkout) {
    return (
      <main className="max-w-lg mx-auto p-8">
        <h1 className="font-serif text-3xl mb-6">Payment</h1>
        <Elements stripe={stripePromise} options={{ clientSecret: checkout.clientSecret }}>
          <PaymentStep orderId={checkout.orderId} />
        </Elements>
      </main>
    );
  }

  const canContinue =
    gdprConsent && form.email && form.name && form.line1 && form.city && form.postalCode && form.country.length === 2;

  return (
    <main className="max-w-lg mx-auto p-8">
      <h1 className="font-serif text-3xl mb-6">Delivery details</h1>
      <div className="space-y-3">
        <input
          className="w-full border rounded p-2"
          placeholder="Email"
          type="email"
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
        />
        <input
          className="w-full border rounded p-2"
          placeholder="Full name"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        <input
          className="w-full border rounded p-2"
          placeholder="Address line 1"
          value={form.line1}
          onChange={(e) => setForm({ ...form, line1: e.target.value })}
        />
        <input
          className="w-full border rounded p-2"
          placeholder="Address line 2 (optional)"
          value={form.line2}
          onChange={(e) => setForm({ ...form, line2: e.target.value })}
        />
        <input
          className="w-full border rounded p-2"
          placeholder="City"
          value={form.city}
          onChange={(e) => setForm({ ...form, city: e.target.value })}
        />
        <input
          className="w-full border rounded p-2"
          placeholder="Postal code"
          value={form.postalCode}
          onChange={(e) => setForm({ ...form, postalCode: e.target.value })}
        />
        <input
          className="w-full border rounded p-2"
          placeholder="Country code (e.g. FR)"
          maxLength={2}
          value={form.country}
          onChange={(e) => setForm({ ...form, country: e.target.value.toUpperCase() })}
        />
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={gdprConsent} onChange={(e) => setGdprConsent(e.target.checked)} />
          <span>
            I consent to my photos being used to personalize this book. Raw photos are
            automatically deleted within 24 hours of delivery.
          </span>
        </label>
        {error && <p className="text-red-600 text-sm">{error}</p>}
        <button
          onClick={handleContinue}
          disabled={submitting || !canContinue}
          className="w-full rounded-full bg-green-700 text-white py-3 font-medium disabled:opacity-50"
        >
          {submitting ? "Please wait…" : "Continue to payment"}
        </button>
      </div>
    </main>
  );
}
