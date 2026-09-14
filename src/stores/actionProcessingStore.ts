import { create } from "zustand";
import { STANDALONE_PROMPT_KEYS } from "../helpers/builtinActions";
import reasoningService from "../services/ReasoningService";
import { getSettings, selectResolvedNoteFormatting } from "./settingsStore";
import { appendDictionarySuffix } from "../config/prompts";
import { generateNoteTitle } from "../utils/generateTitle";
import { buildNoteFormattingOverrides } from "../helpers/noteFormattingOverrides";
import { tagActionItemOwners, type MentionPerson } from "../utils/mentionMarkdown";
import type { ActionItem } from "../types/electron";
import { estimateNoteTokens, planNoteChunks, splitChunkInHalf } from "../helpers/noteChunking";
import type { LocalInferenceError } from "../utils/localInferenceError";
import type { ReasoningConfig } from "../services/BaseReasoningService";

/**
 * Output budget for a formatted note.
 *
 * Without an explicit value this inherited the generic 2048-token default from
 * calculateMaxTokens — roughly 1,500 words — so summaries of long meetings were
 * cut off and saved anyway, with nothing to say they were incomplete (#2142).
 *
 * Deliberately not paired with requireCompleteOutput: unlike a selection edit,
 * where a partial replacement corrupts the user's own text, a clipped summary
 * is still worth keeping. The context preflight counts this reservation, so
 * asking for more output room can grow the window rather than squeeze it.
 */
export const NOTE_OUTPUT_MAX_TOKENS = 4096;

/** Output budget for the working notes of one part of a long recording. */
export const PART_NOTES_MAX_TOKENS = 2048;

// Mirrors CONTEXT_RESERVE_TOKENS in modelManagerBridge: slack the main process
// keeps on top of the output reservation when budgeting each part.
const CONTEXT_RESERVE_TOKENS = 512;
// Parts are packed to this share of the room left after the fixed pieces, so
// the exact tokenizer can run a little hotter than the estimate without a part
// spilling over the window.
const CHUNK_FILL_FRACTION = 0.85;
// Below this a part would hold a minute or two of speech; refuse instead.
const MIN_CHUNK_BUDGET_TOKENS = 1024;
// A part is never larger than this even when the window allows more. Small
// local models lose specifics as the input grows (measured: Llama 3.2 3B given
// a 20k-token part wrote five generic bullets and dropped every number), and
// only the chunked path pays for the extra calls. Roughly an hour of speech.
const MAX_PART_TOKENS = 12288;
const MAX_REDUCE_ROUNDS = 3;
const MAX_SPLIT_DEPTH = 3;

export type ActionProcessingStatus = "idle" | "processing" | "success";

export interface NoteActionProgress {
  step: number;
  total: number;
}

export interface NoteActionState {
  status: ActionProcessingStatus;
  actionName: string | null;
  /** Set while a long note is summarised in parts: "Part 2 of 5". */
  progress?: NoteActionProgress | null;
}

/** The pieces a note action is built from, so a long one can be split along the transcript. */
export interface NoteMaterial {
  notes: string;
  meetingContext: string;
  transcript: string;
}

export interface ActionErrorEvent {
  noteId: number;
  message: string;
  /** Set when the failure has a translatable form; the toast prefers it. */
  messageKey?: string;
  messageParams?: Record<string, string | number>;
}

interface ActionProcessingStoreState {
  noteStates: Record<number, NoteActionState>;
  errorEvents: ActionErrorEvent[];
}

const cancelledFlags = new Map<number, boolean>();
const processingFlags = new Map<number, boolean>();
const successTimers = new Map<number, NodeJS.Timeout>();

const IDLE_STATE: NoteActionState = { status: "idle", actionName: null };

function setNoteState(noteId: number, patch: Partial<NoteActionState>) {
  const { noteStates } = useActionProcessingStore.getState();
  const prev = noteStates[noteId] ?? IDLE_STATE;
  useActionProcessingStore.setState({
    noteStates: { ...noteStates, [noteId]: { ...prev, ...patch } },
  });
}

function clearNoteState(noteId: number) {
  const { noteStates } = useActionProcessingStore.getState();
  const next = { ...noteStates };
  delete next[noteId];
  useActionProcessingStore.setState({ noteStates: next });
}

function pushErrorEvent(event: ActionErrorEvent) {
  const { errorEvents } = useActionProcessingStore.getState();
  useActionProcessingStore.setState({ errorEvents: [...errorEvents, event] });
}

export const useActionProcessingStore = create<ActionProcessingStoreState>()(() => ({
  noteStates: {},
  errorEvents: [],
}));

const BASE_SYSTEM_PROMPT = `You are a note enhancement assistant. The user will provide raw notes — possibly voice-transcribed, rough, or unstructured. Your job is to clean them up according to the instructions below while preserving all original meaning and information. Output clean markdown.

FORMAT RULES (strict):
- Do NOT include any preamble: no title, no date/time/location, no attendee list, no topic header. Start directly with the content.
- Do NOT use tables, horizontal rules, or block quotes.
- Do NOT list or guess participant names/roles.
- Keep the tone professional and concise. Bias toward brevity.

Instructions: `;

const MEETING_SYSTEM_PROMPT = `You are a professional meeting notes assistant. You will receive a meeting transcript where each line is prefixed with the speaker's label — a real name when known, otherwise "You" (the note owner), "Them", or "Speaker N". A "## Meeting Context" block may identify the note owner and the invited participants. Manual notes the user took may be included as well.

Your job is to produce clean, actionable meeting notes in markdown. Follow these rules:

FORMAT RULES (strict):
- Do NOT include any preamble: no title, no "# Meeting Notes", no date/time/location, no attendee list, no topic header. Start directly with the summary.
- Do NOT reproduce the Meeting Context block in the output.
- Do NOT use tables, horizontal rules, or block quotes.
- Refer to people only by the speaker labels used in the transcript. NEVER guess or invent an identity: the note owner is who the Meeting Context says they are — never a name mentioned in conversation. Keep unnamed speakers as "Them" or "Speaker N".
- Start with a concise 1–2 sentence summary of what the meeting was about.
- Use clear section headings: ## Key Discussion Points, ## Decisions Made, ## Action Items, ## Follow-ups (omit any section that has no content).
- Under Action Items, use checkboxes in the format \`- [ ] Action — Owner\`, attributing each item to its owner by speaker label where clear.

CONTENT RULES:
- Preserve important quotes or specific commitments verbatim when they carry meaning.
- Remove filler, small talk, false starts, and repeated/redundant content.
- Where speakers refer to the same topic across multiple turns, consolidate into a coherent point rather than listing every utterance.
- If the user included manual notes alongside the transcript, integrate them — they represent the user's emphasis on what matters most.
- Keep the tone professional and concise. Bias toward brevity.

Instructions: `;

// Standalone built-in prompts are complete instructions, so they only get told
// how the material is laid out instead of being wrapped in the generic prompts.
const MEETING_INPUT_PREAMBLE = `The material is laid out as follows. Transcript lines are prefixed with the speaker's label: a real name when known, otherwise "You" (the note owner), "Them", or "Speaker N". A "## Meeting Context" block may identify the note owner and the invited participants; it is reference material, never something to reproduce. Manual notes the user took may precede the transcript.

`;
const NOTE_INPUT_PREAMBLE = `The material is the user's own notes, possibly voice-transcribed, rough, or unstructured. There is no transcript.

`;

// One part of a recording too long for the local model's window (#2142). The
// user's own action prompt is applied once, to the merged part-notes, so a
// part is asked for faithful working notes rather than the final product.
const PART_NOTES_SYSTEM_PROMPT = `You are writing working notes for one consecutive part of a longer recording. The material is either a transcript, where each line is prefixed with the speaker's label (a real name when known, otherwise "You" for the note owner, "Them", or "Speaker N"), or working notes already written from an earlier pass. A "## Meeting Context" block may identify the note owner and the invited participants; it is reference material, never something to reproduce.

Write detailed working notes in markdown for this part only. Be thorough: these notes replace the material for whoever writes the final notes, so anything you leave out is lost. Use exactly these sections, in this order, and omit a section only if this part truly has nothing for it:

## Topics
One bullet per topic discussed in this part, each with the substance of what was said, in order.

## Decisions
Every decision, agreement or commitment made in this part, one bullet each, with who made it (by label) and any date, amount or condition attached.

## Specifics
Every number, date, amount, deadline, name of a product, customer, vendor or document, and every quote that carries meaning, one bullet each, stated exactly as in the material.

## Action Items
Tasks as \`- [ ] Action — Owner\`, using the speaker labels as they appear.

## Open Questions
Anything raised but not resolved in this part.

Rules:
- Refer to people only by the labels used in the material. NEVER guess or invent an identity.
- Do NOT include a title, a preamble, or a summary of the whole recording; you have only seen this part.
- Do NOT use tables, horizontal rules, or block quotes.

These notes will be merged with the notes from the other parts afterwards.`;

const MERGE_ADDENDUM = `

The material includes ordered working notes from consecutive parts of the user's source, each under a "## Notes from part N of M" heading. Manual notes and meeting context may precede them. Consider all parts together and apply the instructions above, including their requested scope, format, and length. Preserve relevant facts accurately and consolidate repetition. Do not mention the parts or the merging.`;

interface EnhancementRun {
  noteId: number;
  noteContent: string;
  modelId: string;
  systemPrompt: string;
  requestConfig: ReasoningConfig;
  options: RunActionOptions;
  isLocalRoute: boolean;
}

interface LocalContextBudget {
  maxContextTokens: number;
  modelName: string;
}

const isContextTooLarge = (error: unknown): boolean =>
  (error as { code?: string } | null)?.code === "CONTEXT_TOO_LARGE";

const isCancelled = (noteId: number) => cancelledFlags.get(noteId) === true;

async function readLocalContextBudget(modelId: string): Promise<LocalContextBudget | null> {
  try {
    const result = await window.electronAPI?.getLocalContextBudget?.(modelId);
    if (!result?.success || !(result.maxContextTokens && result.maxContextTokens > 0)) return null;
    return { maxContextTokens: result.maxContextTokens, modelName: result.modelName || modelId };
  } catch {
    return null;
  }
}

/** The translated refusal from #2142, for material no amount of splitting can fit. */
function tooLongForModel(modelName: string): LocalInferenceError {
  const error: LocalInferenceError = new Error(
    `Material is too long for ${modelName} on this computer`
  );
  error.code = "CONTEXT_TOO_LARGE";
  error.messageKey = "models.errors.contextTooLargeGeneric";
  error.messageParams = { model: modelName };
  return error;
}

/**
 * One request when the material fits the local window (or on any route the
 * budget does not apply to); parts-then-merge when it does not (#2142).
 */
async function runEnhancement(run: EnhancementRun): Promise<string> {
  const single = (): Promise<string> =>
    reasoningService.processText(run.noteContent, run.modelId, null, run.requestConfig);
  if (!run.isLocalRoute) return single();

  const budget = await readLocalContextBudget(run.modelId);
  if (!budget) return single();

  try {
    // The main-process preflight measures the prompt and can grant a smaller
    // reply. A conservative estimate must not replace a request it can serve.
    return await single();
  } catch (error) {
    if (!isContextTooLarge(error)) throw error;
  }
  if (isCancelled(run.noteId)) throw new Error("cancelled");
  return runInParts(run, budget);
}

async function runInParts(run: EnhancementRun, budget: LocalContextBudget): Promise<string> {
  const material = run.options.material ?? { notes: "", meetingContext: "", transcript: "" };
  const hasTranscript = material.transcript.trim().length > 0;
  const body = hasTranscript ? material.transcript : material.notes || run.noteContent;
  const manualNotes = hasTranscript ? material.notes : "";
  const context = material.meetingContext;

  const fixedTokens =
    estimateNoteTokens(PART_NOTES_SYSTEM_PROMPT) +
    estimateNoteTokens(context) +
    PART_NOTES_MAX_TOKENS +
    CONTEXT_RESERVE_TOKENS;
  const chunkBudget = Math.min(
    MAX_PART_TOKENS,
    Math.floor((budget.maxContextTokens - fixedTokens) * CHUNK_FILL_FRACTION)
  );
  if (chunkBudget < MIN_CHUNK_BUDGET_TOKENS) throw tooLongForModel(budget.modelName);

  const chunks = planNoteChunks(body, chunkBudget);
  if (chunks.length === 0) throw tooLongForModel(budget.modelName);
  const total = chunks.length + 1;
  const partConfig: ReasoningConfig = {
    ...run.requestConfig,
    systemPrompt: PART_NOTES_SYSTEM_PROMPT,
    maxTokens: PART_NOTES_MAX_TOKENS,
  };

  const summarisePart = async (text: string, heading: string, depth = 0): Promise<string> => {
    const content = [context, `## ${heading}\n${text}`].filter(Boolean).join("\n\n");
    try {
      return await reasoningService.processText(content, run.modelId, null, partConfig);
    } catch (error) {
      if (!isContextTooLarge(error) || depth >= MAX_SPLIT_DEPTH) throw error;
      const halves = splitChunkInHalf(text);
      if (!halves) throw error;
      const [first, second] = halves;
      const firstNotes = await summarisePart(first, heading, depth + 1);
      if (isCancelled(run.noteId)) throw error;
      const secondNotes = await summarisePart(second, heading, depth + 1);
      return `${firstNotes}\n\n${secondNotes}`;
    }
  };

  const materialLabel = hasTranscript ? "Meeting Transcript" : "Notes";
  const partNotes: string[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    if (isCancelled(run.noteId)) throw new Error("cancelled");
    setNoteState(run.noteId, { progress: { step: index + 1, total } });
    partNotes.push(
      await summarisePart(chunks[index], `${materialLabel} (part ${index + 1} of ${chunks.length})`)
    );
  }

  const mergeSystemPrompt = run.systemPrompt + MERGE_ADDENDUM;
  let sections = partNotes;
  for (let round = 0; round <= MAX_REDUCE_ROUNDS; round += 1) {
    if (isCancelled(run.noteId)) throw new Error("cancelled");
    setNoteState(run.noteId, { progress: { step: total, total } });
    const mergeContent = [
      manualNotes,
      context,
      ...sections.map(
        (notes, index) => `## Notes from part ${index + 1} of ${sections.length}\n${notes}`
      ),
    ]
      .filter(Boolean)
      .join("\n\n");
    try {
      return await reasoningService.processText(mergeContent, run.modelId, null, {
        ...run.requestConfig,
        systemPrompt: mergeSystemPrompt,
      });
    } catch (error) {
      if (!isContextTooLarge(error)) throw error;
    }
    if (round === MAX_REDUCE_ROUNDS) break;
    // Too many part-notes for one pass: consolidate neighbouring parts and go again.
    const groups = planNoteChunks(sections.join("\n\n"), chunkBudget);
    const consolidated: string[] = [];
    for (let index = 0; index < groups.length; index += 1) {
      if (isCancelled(run.noteId)) throw new Error("cancelled");
      consolidated.push(
        await summarisePart(groups[index], `Working notes (part ${index + 1} of ${groups.length})`)
      );
    }
    sections = consolidated;
  }
  throw tooLongForModel(budget.modelName);
}

export interface RunActionOptions {
  isCloudMode: boolean;
  modelId: string;
  isMeetingNote?: boolean;
  /** Opt-in so enhancement never renames a note the user has titled. */
  allowTitleGeneration?: boolean;
  /** People whose names in generated action-item owners become mention tags. */
  knownPeople?: MentionPerson[];
  /** Structured pieces of `noteContent`; without it a long note is split as plain lines. */
  material?: NoteMaterial;
}

export interface RunActionLabels {
  noModel: string;
  noEndpoint: string;
  actionFailed: string;
}

/**
 * Start processing an action on a note. Runs in the background — survives
 * component unmounts and navigation so the user can switch notes mid-action.
 */
export function runBackgroundAction(
  noteId: number,
  noteContent: string,
  contentHash: string,
  action: ActionItem,
  options: RunActionOptions,
  labels: RunActionLabels
): void {
  if (processingFlags.get(noteId)) return;

  const modelId = options.modelId;
  if (!modelId && !options.isCloudMode) {
    pushErrorEvent({ noteId, message: labels.noModel });
    return;
  }

  const settings = getSettings();
  const noteFormatting = selectResolvedNoteFormatting(settings);
  // A self-hosted config without a URL would fall through to a cloud provider.
  if (!options.isCloudMode && noteFormatting.mode === "self-hosted" && !noteFormatting.remoteUrl) {
    pushErrorEvent({ noteId, message: labels.noEndpoint });
    return;
  }

  cancelledFlags.set(noteId, false);
  processingFlags.set(noteId, true);
  setNoteState(noteId, { status: "processing", actionName: action.name, progress: null });

  (async () => {
    try {
      const standalone =
        !!action.translation_key && STANDALONE_PROMPT_KEYS.has(action.translation_key);
      const basePrompt = standalone
        ? options.isMeetingNote
          ? MEETING_INPUT_PREAMBLE
          : NOTE_INPUT_PREAMBLE
        : options.isMeetingNote
          ? MEETING_SYSTEM_PROMPT
          : BASE_SYSTEM_PROMPT;
      const providerOverrides = buildNoteFormattingOverrides(noteFormatting, options.isCloudMode);
      const systemPrompt = appendDictionarySuffix(
        basePrompt + action.prompt,
        options.isMeetingNote ? settings.customDictionary : undefined,
        settings.uiLanguage
      );
      const requestConfig: ReasoningConfig = {
        systemPrompt,
        maxTokens: NOTE_OUTPUT_MAX_TOKENS,
        temperature: 0.3,
        disableThinking: settings.noteFormattingDisableThinking,
        ...providerOverrides,
      };
      const enhanced = await runEnhancement({
        noteId,
        noteContent,
        modelId,
        systemPrompt,
        requestConfig,
        options,
        isLocalRoute: !options.isCloudMode && noteFormatting.mode === "local",
      });

      if (cancelledFlags.get(noteId)) return;

      let title: string | undefined;
      if (options.allowTitleGeneration && getSettings().autoGenerateNoteTitle) {
        const generated = await generateNoteTitle(enhanced, modelId, providerOverrides);
        if (generated) title = generated;
      }

      if (cancelledFlags.get(noteId)) return;

      const updates: Record<string, string> = {
        enhanced_content: options.knownPeople?.length
          ? tagActionItemOwners(enhanced, options.knownPeople)
          : enhanced,
        enhancement_prompt: action.prompt,
        enhanced_at_content_hash: contentHash,
      };
      if (title) updates.title = title;
      await window.electronAPI.updateNote(noteId, updates);

      setNoteState(noteId, { status: "success", actionName: action.name, progress: null });

      const timer = setTimeout(() => {
        processingFlags.set(noteId, false);
        clearNoteState(noteId);
        successTimers.delete(noteId);
      }, 600);
      successTimers.set(noteId, timer);
    } catch (err) {
      if (cancelledFlags.get(noteId)) return;
      processingFlags.set(noteId, false);
      clearNoteState(noteId);
      const message = err instanceof Error ? err.message : labels.actionFailed;
      const { messageKey, messageParams } = (err ?? {}) as {
        messageKey?: string;
        messageParams?: Record<string, string | number>;
      };
      pushErrorEvent({ noteId, message, messageKey, messageParams });
    } finally {
      cancelledFlags.delete(noteId);
    }
  })();
}

/** Soft cancel: the HTTP request continues but the result is discarded. */
export function cancelAction(noteId: number): void {
  cancelledFlags.set(noteId, true);
  processingFlags.set(noteId, false);
  const timer = successTimers.get(noteId);
  if (timer) {
    clearTimeout(timer);
    successTimers.delete(noteId);
  }
  clearNoteState(noteId);
}

export function consumeErrorEvents(): ActionErrorEvent[] {
  const { errorEvents } = useActionProcessingStore.getState();
  if (errorEvents.length === 0) return [];
  useActionProcessingStore.setState({ errorEvents: [] });
  return errorEvents;
}

export function selectNoteActionState(
  state: ActionProcessingStoreState,
  noteId: number | null
): NoteActionState {
  if (noteId == null) return IDLE_STATE;
  return state.noteStates[noteId] ?? IDLE_STATE;
}
