import { createClient, type SupabaseClient } from "@supabase/supabase-js";
let client: SupabaseClient | null = null;
let workspace = "";
export function configureAuth(url: string, key: string) {
  client = createClient(url, key);
  return client;
}
export const getAuth = () => client;
export const selectWorkspace = (id: string) => {
  workspace = id;
};
export async function api<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = client
    ? (await client.auth.getSession()).data.session?.access_token
    : null;
  const response = await fetch(`/api/v1/${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(workspace ? { "X-Workspace-Id": workspace } : {}),
      ...options.headers,
    },
  });
  const body = await response.json();
  if (!response.ok)
    throw new Error(
      body.error?.fields
        ?.map((f: any) => `${f.path}: ${f.message}`)
        .join(" · ") ||
        body.error?.message ||
        "Unable to load this view.",
    );
  return body.data as T;
}
