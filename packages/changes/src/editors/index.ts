import type { Change, EditorName } from '../change-types';
import type { FieldMap } from '../mapping';
import { type Refusal, refuse } from '../refusal';
import { applyFrontmatterEdit } from './frontmatter';
import { applyHtmlEdit } from './html';
import { applyRedirectEdit } from './redirects';

// One entry point for "apply this change to this file", so the connector does not have to know
// which editor a mapping rule chose. An editor that cannot express a change says so with a reason;
// that check also exists in the mapping (before the file is read), and here as the last line of
// defence for a caller that bypassed it.

export type { FrontmatterEditOutcome } from './frontmatter';
export { frontmatterValue } from './frontmatter';
export type { HtmlEditOutcome } from './html';
export { escapeHtml, findJsonLd, imageSources, scanTag } from './html';
export type { RedirectEditOutcome } from './redirects';
export { redirectRules } from './redirects';
export { applyFrontmatterEdit, applyHtmlEdit, applyRedirectEdit };

export type EditOutcome = { ok: true; text: string; changed: boolean } | Refusal;

export interface EditInput {
  editor: EditorName;
  text: string;
  change: Change;
  /** markdown_frontmatter: the mapping rule's field map. */
  fields?: FieldMap;
}

/** Apply a change to a file's text with the editor the mapping chose. */
export function applyChange({ editor, text, change, fields }: EditInput): EditOutcome {
  if (change.type === 'redirect') {
    if (editor !== 'netlify') return refuse('unsupported', `A redirect is edited in the redirects file, not by the ${editor} editor.`);
    return applyRedirectEdit(text, change);
  }
  if (editor === 'netlify') return refuse('unsupported', `The redirects editor cannot write a ${change.type} change.`);
  if (editor === 'html') return applyHtmlEdit(text, change);
  if (change.type === 'schema.jsonld' || change.type === 'image.alt') {
    return refuse(
      'unsupported',
      `Markdown frontmatter has no field for a ${change.type} change. Add it in the site's build template instead.`,
    );
  }
  return applyFrontmatterEdit(text, change, fields);
}
