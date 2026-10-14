import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { PublicForm } from "@/features/public-form/PublicForm";
import { cachedFormDefinition } from "@/server/forms";

export const metadata: Metadata = { title: "Form · Data Sheets", robots: { index: false } };

/**
 * A public form. Static: the page shell is prerendered, and the form's definition is
 * cached (`use cache`, tagged with the view and its table) until the view or the table's
 * fields change, which expires the tags. Answers go through a Server Action.
 */
export default function FormPage({ params }: PageProps<"/f/[viewId]">) {
  return (
    <main className="mx-auto w-full max-w-xl flex-1 px-4 py-10">
      <Suspense fallback={<div aria-busy className="h-64 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-900" />}>
        <FormLoader params={params} />
      </Suspense>
    </main>
  );
}

async function FormLoader({ params }: Pick<PageProps<"/f/[viewId]">, "params">) {
  const { viewId } = await params;
  const definition = await cachedFormDefinition(viewId);
  if (!definition) notFound();
  return <PublicForm definition={definition} />;
}
