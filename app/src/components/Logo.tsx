// Kolmeia mark ("Favo"). Source of truth: brand/logo-mark.svg. Decorative: put the name next to it.
// Below 28 px it switches to the wider-gap geometry of brand/logo-mark-small.svg.
export function KolmeiaMark({ size = 28 }: { size?: number }) {
  const small = size < 28;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" strokeWidth="1.2" strokeLinejoin="round" className="shrink-0">
      <path fill="currentColor" stroke="currentColor" d={small ? "M5.938 1.713 10.3 4.232v5.036l-4.362 2.519-4.362-2.519V4.232Z" : "M5.938 1.309 10.65 4.03v5.44l-4.712 2.721L1.226 9.47V4.03Z"} />
      <path fill="currentColor" stroke="currentColor" d={small ? "M18.062 1.713 22.424 4.232v5.036l-4.362 2.519L13.7 9.268V4.232Z" : "M18.062 1.309 22.774 4.03v5.44l-4.712 2.721L13.35 9.47V4.03Z"} />
      <path fill="#F5A400" stroke="#F5A400" d={small ? "M12 12.213 16.362 14.732v5.036L12 22.287l-4.362-2.519v-5.036Z" : "M12 11.809 16.712 14.53v5.44L12 22.691 7.288 19.97v-5.44Z"} />
    </svg>
  );
}
