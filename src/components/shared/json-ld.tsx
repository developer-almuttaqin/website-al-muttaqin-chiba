import type { JsonLdNode } from "@/lib/seo";

/** Menyisipkan data terstruktur schema.org. Tanda "<" di-escape agar isi tidak bisa menutup tag script. */
export function JsonLd({ data }: { data: JsonLdNode | JsonLdNode[] }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, "\\u003c") }} />;
}
