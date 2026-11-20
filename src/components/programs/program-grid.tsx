import type { Locale } from "@/lib/types";
import { getPrograms } from "@/lib/data";
import { aos, stagger } from "@/components/shared/aos-props";
import { ProgramCard } from "@/components/programs/program-card";

/**
 * Grid kartu program dari getPrograms(); `limit` membatasi jumlah (mis. untuk beranda).
 * Tiap kartu muncul saat digulir (AOS) bertahap per baris; pembungkus pemanggil jangan ber-data-aos.
 */
export async function ProgramGrid({ locale, limit }: { locale: Locale; limit?: number }) {
  const all = await getPrograms();
  const programs = limit ? all.slice(0, limit) : all;

  return (
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {programs.map((program, i) => (
        // Dengan `limit` (beranda: 4 kartu, satu baris di layar lebar) jeda mengalir lurus; selain itu per baris 3 kolom.
        <div key={program.id} {...aos("fade-up", { delay: stagger(limit ? i : i % 3) })}>
          <ProgramCard program={program} locale={locale} />
        </div>
      ))}
    </div>
  );
}
