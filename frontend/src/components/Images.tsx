import type { Img } from "../api";

export function Images({ items, mounted }: { items: Img[]; mounted: boolean | null }) {
  return (
    <section className="panel">
      <div className="panel-h"><span className="t">AI images</span><span className="n">gallery</span></div>
      <div className="imgs imgs-wide">
        {mounted === null && <div className="empty">Loading…</div>}
        {mounted === false && <div className="empty warn">Images volume not mounted — gallery unavailable.</div>}
        {mounted === true && items.length === 0 && <div className="empty">No generated images yet.</div>}
        {mounted === true && items.map(i => (
          <a key={i.name} className="shot" href={i.url} target="_blank" rel="noreferrer">
            <img src={i.url} alt={i.name} loading="lazy" />
            <span className="cap">{i.name.replace(/\.\w+$/, "")}</span>
          </a>
        ))}
      </div>
    </section>
  );
}
