import type { common as pt } from "../pt/common";
import type { Widen } from "../widen";

export const common = {
  paging: {
    label: "Pagination",
    perPage: "Per page",
    prev: "Previous",
    next: "Next",
    page: "Page {page} of {pages}",
    showing: "Showing {from}–{to} of {total}",
  },
  appName: "Prospecting",
  notConfigured: {
    title: "Database not configured",
    body: "Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in the environment to use the app.",
  },
  login: {
    title: "Sign in",
    signUpTitle: "Create account",
    email: "Email",
    password: "Password",
    passwordHint: "At least 8 characters.",
    signIn: "Sign in",
    signUp: "Create account",
    switchToSignUp: "No account yet? Create one",
    switchToSignIn: "Already have an account? Sign in",
    checkEmail: "Account created. Confirm the email we sent you, then sign in.",
    errors: {
      invalid: "Enter a valid email and a password with at least 8 characters.",
      credentials: "Wrong email or password.",
      generic: "Something went wrong. Try again.",
    },
  },
  signOut: "Sign out",
  roles: {
    closerNotice: "You are signed in as a sales rep: you see the leads and what was handed to you. Agents, campaigns and settings belong to the owner and the SDR.",
  },
  nav: {
    label: "Main",
    agents: "Agents",
    leads: "Leads",
    campaigns: "Email campaigns",
    settings: "Settings",
  },
  onboarding: {
    title: "Create your workspace",
    intro: "Give your workspace a name. Usually it is the company name.",
    name: "Company name",
    submit: "Create workspace",
    errors: {
      invalid: "Enter a name between 1 and 80 characters.",
      generic: "Could not create the workspace. Try again.",
    },
  },
  company: {
    title: "Your company",
    intro: "The clearer you are, the better Research understands what you are looking for.",
    whatWeDo: "What your company does",
    serviceArea: "Where you work",
    wantedWork: "What work you want more of",
    goodCustomer: "Who is a good customer for you",
    notWanted: "Who you do not want",
    save: "Save",
    saving: "Saving…",
    saved: "Saved.",
    errors: {
      whatWeDo: "Describe what the company does (up to 2000 characters).",
      serviceArea: "Say where the company works (up to 2000 characters).",
      wantedWork: "Pick only options from the list.",
      goodCustomer: "Text too long (up to 2000 characters).",
      notWanted: "Text too long (up to 2000 characters).",
      generic: "Could not save. Try again.",
      noWorkspace: "Workspace not found.",
    },
  },
  wantedWorkOptions: {
    new_construction: "New construction",
    multifamily: "Multifamily buildings",
    commercial: "Commercial",
    single_family: "Single-family homes",
    maintenance: "Maintenance contracts",
  },
} satisfies Widen<typeof pt>;
