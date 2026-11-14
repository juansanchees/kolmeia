// What the research engine needs from the database. Production: SupabaseResearchStore (the logged-in user's
// session, RLS applies; rule R14). Tests: a SQL store over PGlite running as the `authenticated` role.
import type { AiLedger } from "@/lib/ai/gateway";
import type { ProfileInput } from "@/lib/ai/prompts/shared";
import type {
  CandidateInsert,
  CandidatePatch,
  CandidateRow,
  CheckInsert,
  CheckRow,
  EvidenceRow,
  JobInsert,
  JobRow,
  RunPatch,
  RunRow,
  SourceInsert,
  SourceRow,
} from "./rows";
import type { Rigor } from "./types";

export type CheckWithEvidence = CheckRow & { evidence: Pick<EvidenceRow, "url" | "title" | "excerpt" | "seen_at">[] };

export type NewRun = {
  workspaceId: string;
  title: string;
  requestText: string;
  regionText: string;
  rigor: Rigor;
  maxCandidates: number;
  maxCostUsd: number;
  maxMinutes: number;
  /** F2: set only for the setup research of a Caçador. */
  setupAgentId?: string;
};

export interface ResearchStore extends AiLedger {
  createRun(r: NewRun): Promise<string>;
  getRun(runId: string): Promise<RunRow | null>;
  updateRun(runId: string, patch: RunPatch): Promise<void>;
  claimStep(runId: string, holder: string, seconds: number): Promise<boolean>;
  releaseStep(runId: string, holder: string): Promise<void>;
  getProfile(workspaceId: string): Promise<ProfileInput>;
  listSources(runId: string): Promise<SourceRow[]>;
  insertSources(workspaceId: string, rows: SourceInsert[]): Promise<void>;
  listCandidates(runId: string): Promise<CandidateRow[]>;
  insertCandidates(workspaceId: string, runId: string, rows: CandidateInsert[]): Promise<CandidateRow[]>;
  updateCandidate(candidateId: string, patch: CandidatePatch): Promise<void>;
  addCheck(c: CheckInsert): Promise<void>;
  listChecks(runId: string): Promise<CheckWithEvidence[]>;
  createList(runId: string, name: string): Promise<string>;
  /** G10: idempotent (a job already stored for the run is skipped). */
  insertJobs(runId: string, rows: JobInsert[]): Promise<void>;
  listJobs(runId: string): Promise<JobRow[]>;
}
