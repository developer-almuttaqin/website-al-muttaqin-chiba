/**
 * Animasi saat gulir (AOS, "animate on scroll") untuk Server maupun Client Component.
 *
 * Pemakaian: sebar ke elemen DOM biasa (bukan komponen yang tidak meneruskan props):
 *   <li {...aos("fade-up", { delay: stagger(i) })}>...</li>
 * atau tulis atributnya langsung: <div data-aos="zoom-in" data-aos-delay={120}>.
 *
 * Mesinnya `AosRuntime` (src/components/shared/aos.tsx) dan CSS-nya di globals.css (bagian AOS).
 * Aturan: jangan menumpuk data-aos di elemen yang induknya juga ber-data-aos; pasang di pembungkus
 * yang tidak punya transisi/hover sendiri (mis. <li> di sekitar kartu, bukan <Link> kartunya).
 */
export const AOS_ANIMATIONS = ["fade", "fade-up", "fade-down", "fade-left", "fade-right", "zoom-in", "zoom-in-up", "zoom-out", "flip-up", "slide-up"] as const;
export type AosAnimation = (typeof AOS_ANIMATIONS)[number];

export type AosProps = {
  "data-aos": AosAnimation;
  "data-aos-delay"?: number;
  "data-aos-duration"?: number;
};

/** Atribut AOS untuk satu elemen. `delay`/`duration` dalam milidetik (mesin membatasi delay maks. 600 ms). */
export function aos(animation: AosAnimation = "fade-up", opts: { delay?: number; duration?: number } = {}): AosProps {
  const props: AosProps = { "data-aos": animation };
  if (opts.delay && opts.delay > 0) props["data-aos-delay"] = Math.round(opts.delay);
  if (opts.duration && opts.duration > 0) props["data-aos-duration"] = Math.round(opts.duration);
  return props;
}

/** Jeda bertahap untuk item daftar/grid: 0, 80, 160, ... dibatasi `max` agar daftar panjang tidak menunggu lama. */
export function stagger(index: number, step = 80, max = 320): number {
  return Math.min(Math.max(0, index) * step, max);
}
