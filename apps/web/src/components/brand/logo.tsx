/**
 * The Nexora brand mark.
 *
 * The name is NEXT + AURA, and the mark is built from exactly those two ideas:
 *
 *   • NEXT — the "N", whose diagonal doubles as a rising line. It travels
 *     upward and forward, ending at the top right: the direction of the next
 *     move, not a record of the last one.
 *
 *   • AURA — the radiant point at the end of that climb, wrapped in a halo.
 *     The aura is the AI: the glow of intelligence around the business. It sits
 *     at the terminus deliberately, because the whole promise of the product is
 *     that the intelligence is where you are *going*, not where you have been.
 *
 * Craft notes:
 *
 *   • Built on a 24×24 grid with 2px strokes and round caps, so everything lands
 *     on whole or half pixels and stays crisp at 16px — the favicon size, where
 *     most logos turn to mush. The halo is the one element that softens at that
 *     size, which is fine: it is the supporting voice, and the N carries the
 *     mark alone when it has to.
 *
 *   • `currentColor` by default, so the mark inherits text colour and works in
 *     light mode, dark mode, on a button, or disabled — with no extra variants.
 *
 *   • No text baked into the SVG. The wordmark is real text, so it stays
 *     selectable, translatable and readable by a screen reader.
 */

interface LogoMarkProps {
  className?: string;
  /** Use the brand gradient instead of inheriting text colour. */
  gradient?: boolean;
}

export function LogoMark({ className = 'h-6 w-6', gradient = false }: LogoMarkProps) {
  const gradientId = 'nexora-mark-gradient';

  // Resolved once, so the N, the halo and the point can never drift apart.
  const stroke = gradient ? `url(#${gradientId})` : 'currentColor';

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      // The mark is decorative wherever it sits next to the wordmark; the
      // accessible name comes from the text. Where it stands alone, the caller
      // wraps it in a labelled element.
      aria-hidden="true"
      focusable="false"
    >
      {gradient && (
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
            <stop stopColor="#6366F1" />
            <stop offset="1" stopColor="#8B5CF6" />
          </linearGradient>
        </defs>
      )}

      {/* NEXT — the N. Left stem, rising diagonal, right stem, drawn as one path
          so the joins are true corners rather than three strokes colliding. */}
      <path
        d="M5 19V5l14 14V5"
        stroke={stroke}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* AURA — the halo. Deliberately thin and semi-transparent: an aura is
          something you sense at the edge of vision, not a hard ring. It is also
          the first thing to fade at small sizes, which is correct — it is the
          supporting voice, and the N must survive without it. */}
      <circle
        cx="19"
        cy="5"
        r="4.25"
        stroke={stroke}
        strokeWidth="1"
        opacity="0.35"
      />

      {/* The radiant point itself, at the terminus of the climb. */}
      <circle cx="19" cy="5" r="2.25" fill={stroke} />
    </svg>
  );
}

interface LogoProps {
  className?: string;
  /** Hides the wordmark — for a collapsed sidebar or a mobile header. */
  markOnly?: boolean;
  gradient?: boolean;
}

/** The lockup: mark plus wordmark. */
export function Logo({ className = '', markOnly = false, gradient = false }: LogoProps) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <LogoMark className="h-6 w-6 shrink-0" gradient={gradient} />

      {!markOnly && (
        // Tight tracking and a semibold weight: the wordmark should read as one
        // object, not six letters. `select-none` because nobody wants to
        // accidentally highlight the logo while dragging.
        <span className="select-none text-[17px] font-semibold tracking-tight">
          Nexora
        </span>
      )}
    </span>
  );
}
