import { createApp, type Config } from "./app.ts";
import { createAiConfig } from "./ai-provider.ts";
import { SupabaseRepository, userClient } from "./repository.ts";

export function createHostedConfig(): Config {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  const schema = process.env.IMPLEMENTATION_OS_DB_SCHEMA ?? "public";
  if (process.env.VERCEL && !process.env.IMPLEMENTATION_OS_DB_SCHEMA)
    throw new Error("Set IMPLEMENTATION_OS_DB_SCHEMA for hosted deployments.");
  if (!/^[a-z][a-z0-9_]*$/.test(schema))
    throw new Error("Invalid Implementation OS database schema.");
  const origin =
    process.env.APP_ORIGIN ??
    (process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : "http://127.0.0.1:5180");

  return {
    demo: false,
    ...createAiConfig(),
    origin,
    supabaseUrl: url,
    publishableKey: key,
    authenticate: async (token) => {
      if (!url || !key || !token) return null;
      const client = userClient(url, key, token);
      const { data, error } = await client.auth.getUser(token);
      if (error || !data.user || !data.user.email_confirmed_at) return null;
      return {
        id: data.user.id,
        email: data.user.email ?? "",
        repo: new SupabaseRepository(client, schema),
      };
    },
    signup:
      url && key
        ? async (email, password) => {
            const { data, error } = await userClient(url, key).auth.signUp({
              email,
              password,
              ...(schema === "implementation_os"
                ? { options: {
                    data: { nexus_managed_workspace: "true" },
                    emailRedirectTo: origin,
                  } }
                : {}),
            });
            if (error) throw new Error("Signup unavailable");
            return { confirmation_required: !data.session };
          }
        : undefined,
  };
}

export function createHostedApp() {
  if (process.env.IMPLEMENTATION_OS_DEMO === "1")
    throw new Error("Local demo cannot run in a hosted deployment.");
  return createApp(createHostedConfig());
}
