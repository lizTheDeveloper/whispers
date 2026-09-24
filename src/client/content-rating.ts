import type { WsClient } from './ws-client.js';
import type { ServerMessage } from '../shared/protocol.js';
import { CONTENT_RATINGS, RATING_BLURB, ratingLabel, isContentRating, type ContentRating } from '../shared/rating.js';

/**
 * The content rating on screen (round 20): a small badge every seat sees,
 * and the host's control — a select in the DM lobby's sidebar, beside Pause
 * and End Game in the game view, and in the host's panel of the character
 * creator. The server owns the rating; the control only asks
 * (set-content-rating) and repaints from the server's content-rating.
 */

export interface RatingInfo {
  rating: ContentRating;
  explicit: boolean;
  childPresent: boolean;
}

/** Only the parts of WsClient these widgets use (tests pass a fake). */
type RatingSocket = Pick<WsClient, 'on' | 'send'>;

let last: RatingInfo | null = null;
const tracked = new WeakSet<object>();

function infoOf(msg: ServerMessage): RatingInfo | null {
  if (msg.type !== 'content-rating' || !isContentRating(msg.rating)) return null;
  return { rating: msg.rating, explicit: Boolean(msg.explicit), childPresent: Boolean(msg.childPresent) };
}

/**
 * Remember the latest rating from this socket, so a view mounted after it
 * arrived (the lobby turning into the game view) paints it at once. main.ts
 * calls this at startup; the widgets call it too.
 */
export function trackContentRating(ws: RatingSocket): void {
  if (tracked.has(ws)) return;
  tracked.add(ws);
  ws.on('content-rating', msg => {
    const info = infoOf(msg);
    if (info) last = info;
  });
}

/** The latest rating seen, or null before the server has said. */
export function lastContentRating(): RatingInfo | null {
  return last;
}

/** Tests: forget the remembered rating. */
export function resetContentRating(): void {
  last = null;
}

/** The one line under the host's control when a child PC is at a table rated above gentle. */
export const CHILD_NOTICE = 'A player character is a child. That is allowed — adults may play one — but this table is rated above Gentle.';

/** The small badge: "Rated Storybook", with the level's blurb as its title. Hidden until the server says. */
export function mountRatingBadge(container: HTMLElement, ws: RatingSocket): HTMLElement {
  trackContentRating(ws);
  const badge = document.createElement('span');
  badge.className = 'rating-badge hidden';
  badge.setAttribute('role', 'status');
  container.appendChild(badge);
  const paint = (info: RatingInfo | null) => {
    if (!info) return;
    badge.textContent = `Rated ${ratingLabel(info.rating)}`;
    badge.title = RATING_BLURB[info.rating];
    badge.dataset.rating = info.rating;
    badge.classList.remove('hidden');
  };
  paint(last);
  ws.on('content-rating', msg => {
    if (!badge.isConnected) return;
    paint(infoOf(msg));
  });
  return badge;
}

/**
 * The host's control: the four levels, what the chosen one means, whether
 * it is still the default, and — when a player character is a child and the
 * rating is above gentle — a one-line notice (never a block). A change is
 * sent to the server and the select waits for its answer.
 */
export function mountRatingControl(container: HTMLElement, ws: RatingSocket): HTMLElement {
  trackContentRating(ws);
  const box = document.createElement('div');
  box.className = 'rating-control';
  const label = document.createElement('label');
  label.className = 'rating-label';
  label.textContent = 'Content rating ';
  const select = document.createElement('select');
  select.className = 'rating-select';
  select.setAttribute('aria-label', 'Content rating');
  for (const r of CONTENT_RATINGS) {
    const opt = document.createElement('option');
    opt.value = r;
    opt.textContent = ratingLabel(r);
    select.appendChild(opt);
  }
  label.appendChild(select);
  const blurb = document.createElement('p');
  blurb.className = 'rating-blurb paste-hint';
  const notice = document.createElement('p');
  notice.className = 'rating-child-notice hidden';
  notice.setAttribute('role', 'note');
  notice.textContent = CHILD_NOTICE;
  box.append(label, blurb, notice);
  container.appendChild(box);

  let current: RatingInfo | null = null;
  const paint = (info: RatingInfo | null) => {
    if (!info) return;
    current = info;
    select.value = info.rating;
    select.disabled = false;
    blurb.textContent = `${RATING_BLURB[info.rating]}${info.explicit ? '' : ' (The default — change it any time.)'}`;
    notice.classList.toggle('hidden', !(info.childPresent && info.rating !== 'gentle'));
  };
  paint(last);
  if (!current) select.disabled = true;

  select.addEventListener('change', () => {
    const rating = select.value;
    if (!isContentRating(rating) || (rating === current?.rating && current?.explicit)) return;
    // What it would mean, at once; the server's answer confirms (or puts it back).
    blurb.textContent = RATING_BLURB[rating];
    notice.classList.toggle('hidden', !(current?.childPresent && rating !== 'gentle'));
    select.disabled = true;
    ws.send({ type: 'set-content-rating', rating });
  });
  ws.on('content-rating', msg => {
    if (!box.isConnected) return;
    paint(infoOf(msg));
  });
  // A refused change (an error) puts the control back as the server has it.
  ws.on('error', () => {
    if (!box.isConnected || !select.disabled || !current) return;
    paint(current);
  });
  return box;
}
