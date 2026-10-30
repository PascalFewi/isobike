/**
 * The small footer: author, source code, legal pages, contact. A thin strip
 * under the map on desktop; at the end of the route tab on phones.
 */

export const REPO_URL = 'https://github.com/PascalFewi/isobike';
/** Contact opens a new issue on the repository. */
const CONTACT_URL = `${REPO_URL}/issues/new`;
// TODO: real pages once written.
const IMPRESSUM_URL = '#impressum';
const DATENSCHUTZ_URL = '#datenschutz';

export function GitHubIcon({ size = 14 }: { readonly size?: number }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
      <path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export function Footer(): JSX.Element {
  return (
    <footer className="footer">
      <span>Autor Pascal Feigenwinter 2026</span>
      <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
        <GitHubIcon size={12} /> Code Open Source auf GitHub
      </a>
      <a href={IMPRESSUM_URL}>Impressum</a>
      <a href={DATENSCHUTZ_URL}>Datenschutz</a>
      <a href={CONTACT_URL} target="_blank" rel="noopener noreferrer">Kontakt</a>
    </footer>
  );
}
