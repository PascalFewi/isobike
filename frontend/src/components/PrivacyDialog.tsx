/**
 * "Datenschutz": what the site processes and who else receives data, opened
 * from the footer. It describes what the code does -- when a service is added
 * or removed (lib/analytics.ts, lib/geocode.ts, config.ts, index.html, the
 * server's log), change this text with it.
 *
 * A native <dialog>, like ExportDialog.
 */

import { useEffect, useRef } from 'react';

interface Props {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Where privacy requests go. */
  readonly contactUrl: string;
}

function Ext({ href, children }: { readonly href: string; readonly children: string }): JSX.Element {
  return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
}

export function PrivacyDialog({ open, onClose, contactUrl }: Props): JSX.Element {
  const dialog = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const d = dialog.current;
    if (d === null) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      className="export-dialog legal"
      aria-labelledby="privacy-title"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {open && (
        <>
          <div className="export-body">
            <header className="export-head">
              <h2 id="privacy-title">Datenschutzerklärung</h2>
              <small>Stand: November 2026</small>
            </header>

            <section>
              <h3>Kurz gesagt</h3>
              <p>
                isobike braucht kein Konto und setzt keine Cookies. Deine Routen werden nicht gespeichert. Gezählt wird nur, wie oft die Seite und einzelne Funktionen benutzt werden.
              </p>
            </section>

            <section>
              <h3>Verantwortlich</h3>
              <p>
                Pascal Feigenwinter, Schweiz. Kontakt und Anfragen zum Datenschutz:{' '}
                <Ext href={contactUrl}>über GitHub</Ext>.
              </p>
            </section>

            <section>
              <h3>Server und Routenberechnung</h3>
              <p>
                Die Seite läuft auf einem Server der Hetzner Online GmbH (Sitz in Deutschland, Rechenzentrum in Finnland). Beim Aufruf verarbeitet der
                Server technisch notwendige Daten und schreibt sie in ein Zugriffsprotokoll: IP-Adresse, Zeitpunkt,
                abgerufene Adresse und Angaben deines Browsers. Das Protokoll dient nur dem Betrieb und der
                Fehlersuche und wird laufend überschrieben.
              </p>
              <p>
                Um Erreichbarkeit und Routen zu berechnen, schickt dein Browser die Koordinaten der gesetzten Punkte und
                deine Einstellungen (Fahrrad, Profil, maximale Steigung) an diesen Server. Sie werden für die Antwort
                verwendet und nicht gespeichert.
              </p>
            </section>

            <section>
              <h3>Nutzungsstatistik (Umami)</h3>
              <p>
                Für eine Besucherstatistik läuft die Open-Source-Software Umami auf dem eigenen Server
                (stats.isobike.ch). Die Statistikdaten bleiben dort und werden an niemanden weitergegeben. Umami setzt
                keine Cookies und erkennt dich auf anderen Websites nicht wieder.
              </p>
              <p>Erfasst wird pro Aufruf:</p>
              <ul>
                <li>die aufgerufene Seite und die Seite, von der du kommst (Referrer)</li>
                <li>Browser, Betriebssystem, Gerätetyp, Bildschirmgrösse und Sprache</li>
                <li>das ungefähre Herkunftsgebiet (Land, Region, Stadt), abgeleitet aus der IP-Adresse</li>
              </ul>
              <p>
                Die IP-Adresse wird dabei nur kurz verarbeitet, um daraus zusammen mit Browserangaben und einem
                regelmässig wechselnden Zufallswert eine anonyme Besuchskennung zu berechnen. Sie wird nicht in der
                Statistik gespeichert.
              </p>
              <p>Zusätzlich werden diese Aktionen gezählt:</p>
              <ul>
                <li>Punkt gesetzt (per Karte oder Suche, und der wievielte Punkt es ist)</li>
                <li>Export-Dialog geöffnet (Anzahl Punkte)</li>
                <li>GPX heruntergeladen (Anzahl Punkte, gerundete Distanz, Fahrradtyp)</li>
                <li>«Hin und zurück» benutzt</li>
              </ul>
              <p>
                Koordinaten, Ortsnamen und Routen werden <strong>nicht</strong> in der Statistik erfasst. Sendet dein
                Browser «Do Not Track», wirst du nicht gezählt; ein Werbe- oder Trackingblocker verhindert die Zählung
                ebenfalls. Mehr zur Software: <Ext href="https://umami.is">umami.is</Ext>.
              </p>
            </section>

            <section>
              <h3>Dienste Dritter</h3>
              <p>Dein Browser ruft Inhalte direkt bei diesen Anbietern ab. Sie erhalten dabei deine IP-Adresse.</p>
              <ul>
                <li>
                  <strong>swisstopo (geo.admin.ch):</strong> Ortssuche und Ortsnamen. Übermittelt werden dein Suchtext
                  und die Koordinaten eines auf der Karte gesetzten Punkts.
                </li>
                <li><strong>OpenFreeMap:</strong> die Hintergrundkarte. Übermittelt wird der betrachtete Kartenausschnitt.</li>
                <li><strong>Google Fonts:</strong> die Schriften der Seite.</li>
              </ul>
            </section>

            <section>
              <h3>Deine Rechte</h3>
              <p>
                Du kannst Auskunft über die zu dir bearbeiteten Daten verlangen sowie deren Berichtigung oder Löschung.
                Weil die Seite ohne Konto funktioniert und keine Kennung speichert, lassen sich Daten in der Regel
                keiner Person zuordnen. Es gilt das Schweizer Datenschutzgesetz (DSG); Aufsichtsbehörde ist der
                Eidgenössische Datenschutz- und Öffentlichkeitsbeauftragte (EDÖB).
              </p>
            </section>
          </div>

          <div className="export-actions">
            <button type="button" onClick={onClose}>Schliessen</button>
          </div>
        </>
      )}
    </dialog>
  );
}
