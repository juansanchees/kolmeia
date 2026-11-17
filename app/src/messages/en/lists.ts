import type { lists as pt } from "../pt/lists";
import type { Widen } from "../widen";

export const lists = {
  title: "Lists",
  subtitle: "A lead can be on several lists. Deleting a list does not delete the leads.",
  columns: { name: "List", leads: "Leads", contacted: "Contacted", phone: "With phone", actions: "Actions" },
  open: "Open",
  emptyList: "This list has no leads you can see yet.",
  csv: "Export CSV",
  csvNote: "Export CSV: owner and SDR only. The sales rep only sees the leads handed to them.",
  empty: "No lists yet. On the Leads screen, check leads and use \"Add to list\".",
  newList: "New list",
  newName: "New list name",
  create: "Create list",
  add: {
    button: "Add to list",
    title: "Add {n} lead(s) to the list",
    existing: "Existing list",
    pickOne: "Pick a list",
    or: "or",
    newName: "New list",
    confirm: "Add",
    cancel: "Cancel",
    done: "{n} lead(s) on the list.",
    none: "Check at least 1 lead.",
  },
  created: "List created.",
  failed: "That did not work. Try again.",
  duplicate: "A list with this name already exists.",
} satisfies Widen<typeof pt>;
