export type Note = {
  id: string;
  title: string;
  content_json: string;
  content_text: string;
  is_pinned: boolean;
  pinned_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type NoteSummary = {
  id: string;
  title: string;
  preview: string;
  is_pinned: boolean;
  pinned_at: string | null;
  updated_at: string;
};

export type SearchHit = {
  id: string;
  title: string;
  snippet: string;
  is_pinned: boolean;
  updated_at: string;
  score: number;
};

export type Snapshot = {
  id: string;
  note_id: string;
  title: string;
  content_json: string;
  content_text: string;
  created_at: string;
  is_manual: boolean;
  manual_label: string | null;
};

export type UpdateNoteInput = {
  id: string;
  title: string;
  content_json: string;
  content_text: string;
  mention_target_ids: string[];
};
