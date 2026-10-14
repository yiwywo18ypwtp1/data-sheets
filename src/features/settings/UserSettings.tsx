import { getCurrentUser, listUsers } from "@/server/auth";
import { switchUser } from "./actions";

const ROLE_HINTS = {
  viewer: "can only read",
  editor: "can edit records and save views",
  creator: "can also change fields and import",
} as const;

/**
 * A plain form posting to a Server Action: it works without client JavaScript,
 * so this page needs no Client Component at all.
 */
export async function UserSettings() {
  const [current, users] = [await getCurrentUser(), listUsers()];

  return (
    <form action={switchUser} className="space-y-3">
      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm text-zinc-500">Act as</legend>
        {users.map((user) => (
          <label key={user.id} className="flex items-center gap-2 text-sm">
            <input type="radio" name="userId" value={user.id} defaultChecked={user.id === current.id} />
            <span className="font-medium">{user.name}</span>
            <span className="text-zinc-500">
              {user.role} — {ROLE_HINTS[user.role]}
            </span>
          </label>
        ))}
      </fieldset>
      <button type="submit" className="rounded bg-zinc-900 px-3 py-1.5 text-sm text-white dark:bg-zinc-100 dark:text-zinc-900">
        Switch user
      </button>
    </form>
  );
}
