/**
 * Turns the backend's raw errors into something a person can act on.
 *
 * The three failures below are what you hit on a fresh Supabase project before the
 * setup steps have been run, and their native messages ("Bucket not found", a bare
 * PGRST205 code) give no clue what to do about it.
 */

const RULES = [
  {
    match: (text) => /anonymous_provider_disabled|anonymous sign-ins are disabled/i.test(text),
    message:
      'Guest access is turned off for this Supabase project. Enable it under ' +
      'Authentication → Sign In / Providers → Anonymous sign-ins, or sign in with an email instead.',
  },
  {
    match: (text) => /PGRST205|could not find the table|relation .* does not exist/i.test(text),
    message:
      'The database tables do not exist yet. Run the migration in ' +
      'supabase/migrations/ — paste it into the Supabase SQL editor, or run `supabase db push`.',
  },
  {
    match: (text) => /bucket not found|nosuchbucket/i.test(text),
    message:
      'The device-images storage bucket does not exist yet. It is created by the migration in ' +
      'supabase/migrations/ — run that first.',
  },
  {
    match: (text) => /Failed to send a request to the Edge Function|FunctionsFetchError/i.test(text),
    message:
      'The analyze-device function is not deployed. Run `supabase functions deploy analyze-device` ' +
      'and set the Mistral key with `supabase secrets set MISTRAL_API_KEY=...`.',
  },
  {
    match: (text) => /MISTRAL_API_KEY is not set/i.test(text),
    message:
      'The deployed function has no Mistral key. Run ' +
      '`supabase secrets set MISTRAL_API_KEY=...` and redeploy.',
  },
  {
    match: (text) => /JWT|invalid api key|401/i.test(text),
    message:
      'Supabase rejected the API key. Check VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env, ' +
      'then restart the dev server — Vite only reads .env at startup.',
  },
]

/** A readable, actionable message for an error from Supabase or an edge function. */
export function describeError(error) {
  const text = [error?.message, error?.error_description, error?.code, error?.details]
    .filter(Boolean)
    .join(' ')

  const rule = RULES.find((r) => r.match(text))
  if (rule) return rule.message

  return error?.message || 'Something went wrong. Check the browser console for details.'
}
