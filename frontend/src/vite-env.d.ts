/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_WORKER_URL?: string;
  readonly VITE_PMTILES_URL?: string;
  readonly VITE_POIS_URL?: string;
  readonly VITE_BASEMAP_STYLE_URL?: string;
  readonly VITE_AD_PLACEHOLDERS?: string;
  readonly VITE_SITE_SCRIPT_URL?: string;
  readonly VITE_UMAMI_WEBSITE_ID?: string;
  readonly VITE_UMAMI_SCRIPT_URL?: string;
  readonly VITE_UMAMI_DOMAINS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
