import { Suspense } from "react";
import { UserSettings } from "@/features/settings/UserSettings";

export default function SettingsPage() {
  return (
    <div className="m-8 max-w-md space-y-4">
      <h1 className="text-lg font-semibold">Settings</h1>
      {/* Reads the user cookie, so it renders per request inside the boundary. */}
      <Suspense fallback={<p className="text-sm text-zinc-400">Loading users…</p>}>
        <UserSettings />
      </Suspense>
    </div>
  );
}
