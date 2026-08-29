import Link from "next/link";

export default function Home() {
  return (
    <main className="max-w-2xl mx-auto p-8">
      <h1 className="font-serif text-3xl mb-4">Your Storybook</h1>
      <p className="mb-6">
        Personalize a book on the homepage, then come back here to check out.
      </p>
      <Link href="/cart" className="rounded-full bg-green-700 text-white px-6 py-3 font-medium">
        View cart
      </Link>
    </main>
  );
}
