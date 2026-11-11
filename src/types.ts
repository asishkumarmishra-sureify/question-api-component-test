/** Wire-level envelope every ApplynBuyAPI response uses (APIController::sendResponse). */
export interface Envelope {
  code: number;
  status: boolean | string;
  /** Payload. The decoder accepts either a plain JSON object or a
   *  base64-encoded JSON string, so both deployment styles work. */
  response: string | Record<string, unknown>;
  errors?: unknown;
}

export type Adm = Record<string, unknown>;

export interface RawOption { id: string; label: string; [k: string]: unknown }

export interface RawQuestion {
  /** Treated as an opaque string: it is not always a UUID (e.g. 'QuoteExperiencesQuestion'). */
  question_id: string;
  sureify_id?: string;
  question_text?: string;
  display_type?: string;
  question_type?: string;
  is_hidden?: boolean;
  question_status?: string;
  question_status_message?: string;
  response?: unknown;
  response_options?: RawOption[];
  /** The tree parser walks both: structural nesting (breadcrumb → group → leaf)
   *  via `questions`, reflexive children via `child_questions`. Either may be
   *  the literal `false` instead of an array, which the parser treats as empty. */
  questions?: RawQuestion[] | false;
  child_questions?: RawQuestion[] | false;
  sequence_number?: number;
  validations?: unknown;
  properties?: Record<string, unknown>;
}

/** Breadcrumbs are read from the response's top-level array, not from question nodes. */
export interface RawBreadcrumb {
  breadcrumb_id: string;
  section_id?: string;
  title?: string;
  /** 'active' marks the current breadcrumb. */
  state?: string;
  type?: string;
  clickable?: boolean;
  show?: boolean;
  section_progress?: unknown;
}

/** Decoded payload of a /questions call. These are the field locations the
 *  engine reads during ingest; optional fallbacks cover older layouts. */
export interface QuestionsResponse {
  other_params?: {
    uid?: string;
    session_id?: string;
    app_id?: string;
    current_status?: string;
    current_role?: { uuid?: string; name?: string };
    current_acquire_version?: string;
    page_sequence_number?: number;
    [k: string]: unknown;
  };
  data?: {
    questionnaire?: {
      page_sequence_number?: number;
      questions?: RawQuestion[] | RawQuestion;
      completed?: boolean;
    };
  };
  breadcrumbs?: RawBreadcrumb[];
  /** An EMPTY ADM arrives as `[]` (PHP empty array); ingest normalizes it to `{}`. */
  application_data_model?: Adm | unknown[];
  answered_groups?: string[];
  /** Legacy location of uid (older deployments). */
  uid?: string;
  [k: string]: unknown;
}

export type QuestionsEvent =
  | 'load_application'
  | 'next_page'
  | 'page_state_change'
  | 'confirm_update'
  | 'navigate_to_breadcrumb'
  | 'signing_complete';
