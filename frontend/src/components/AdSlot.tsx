/**
 * A marked place for an ad or a partner link -- empty in this code base.
 *
 * The open-source app only reserves the space: an empty, hidden
 * `<aside data-ad-slot="...">`. A deployment fills it from outside -- its site
 * script (`VITE_SITE_SCRIPT_URL`, loaded by main.tsx) finds the element by its
 * `data-ad-slot`, puts the content in, labels it "Anzeige" (advertising must be
 * recognisable) and unhides it. Without a site script the slot stays empty.
 *
 * During development (`npm run dev`) or with `VITE_AD_PLACEHOLDERS=true`, and
 * no site script configured, a grey placeholder shows where the slots are.
 */

export type AdSlotId = 'planner' | 'export';

const SHOW_PLACEHOLDER =
  !import.meta.env.VITE_SITE_SCRIPT_URL && (import.meta.env.DEV || import.meta.env.VITE_AD_PLACEHOLDERS === 'true');

const PLACEHOLDER: Record<AdSlotId, string> = {
  planner: 'Werbefläche, z. B. Velo-Shop oder Region',
  export: 'Werbefläche, z. B. Unterkünfte entlang der Route',
};

export function AdSlot({ id }: { readonly id: AdSlotId }): JSX.Element | null {
  if (!SHOW_PLACEHOLDER) return <aside className="ad-slot" data-ad-slot={id} aria-label="Anzeige" hidden />;
  return (
    <aside className="ad-slot placeholder" data-ad-slot={id} aria-label="Anzeige">
      <span className="ad-label">Anzeige</span>
      <div className="ad-body">{PLACEHOLDER[id]}</div>
    </aside>
  );
}
