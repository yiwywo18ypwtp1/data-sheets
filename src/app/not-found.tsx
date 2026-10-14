import Link from "next/link";

export default function NotFound() {
  return (
    <div className="m-8 space-y-3">
      <h2 className="text-lg font-semibold">Not found</h2>
      <p className="text-sm text-zinc-500">This base, table or view doesn&apos;t exist, or the link mixes up ids from different tables.</p>
      <Link href="/" className="text-sm text-blue-600 hover:underline">
        Go to the first table
      </Link>
    </div>
  );
}
