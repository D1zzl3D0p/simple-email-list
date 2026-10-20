export type Clock = () => Date;
export type RunId = string;
export type InboundKind = "broadcast" | "command";
export type OutboxKind = "newsletter" | "owner";
export type OutboxState =
  | "pending"
  | "sending"
  | "accepted"
  | "delivered"
  | "retry_wait"
  | "review_required"
  | "failed"
  | "cancelled";
type RuntimeBindings = {
  [K in keyof Cloudflare.Env]: Cloudflare.Env[K] extends string
    ? string
    : Cloudflare.Env[K];
};
export interface Env extends RuntimeBindings {
  CAPABILITY_SECRET: string;
  TURNSTILE_SECRET: string;
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  CLOUDFLARE_EXPORT_TOKEN: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_DATABASE_ID: string;
}
export interface Settings {
  id: number;
  owner: string;
  missionary: string;
  approved_senders: string;
  display_name: string;
  album_url: string;
  paused: number;
  transport_paused: string | null;
  quota_retry_at: number | null;
  version: number;
}
export interface AdminIdentity {
  email: string;
  role: "missionary" | "owner";
}
export interface IncidentInput {
  runId?: string;
  sourceKey: string;
  code: string;
  detail: string;
  affected?: number;
}
export interface Snapshot {
  active: number;
  suppressed: number;
  pending: number;
  accepted: number;
  delivered: number;
  uncertain: number;
  held: number;
  oldest: number | null;
  attempts: number;
  newsletter_attempts: number;
  incidents: number;
  paused: number;
  transport_paused: string | null;
  quota_retry_at: number | null;
  newsletter_pending: number;
  joined_week: number;
  changed_week: number;
  updates_week: number;
  demand_week: number;
  validation_faults: number;
  newsletter_limit: number;
  total_limit: number;
  newsletter_remaining: number;
  total_remaining: number;
  oldest_age_hours: number | null;
  projected_hours: number | null;
  weekly_capacity: number;
  warnings: string[];
}
export interface PreparedMail {
  subject: string;
  text: string;
  html: string;
  rawKey: string;
  sender: string;
  receivedAt: number;
}
export interface OutgoingMail {
  recipient: string;
  subject: string;
  text: string;
  html: string;
  replyTo: string;
  unsubscribe?: string;
  deliveryId: string;
}
export type SendResult =
  | { kind: "accepted"; messageId: string }
  | { kind: "safe_retry"; dueAt: number; reason: string }
  | { kind: "quota_exhausted"; dueAt: number; reason: string }
  | {
      kind: "permanent_reject" | "configuration_error" | "uncertain";
      reason: string;
    };
export interface Subscriber {
  id: string;
  email: string;
  status: "active" | "unsubscribed";
  generation: number;
  version: number;
}
