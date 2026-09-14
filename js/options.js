/**
 * Default configuration options for FetchStream.
 */
const OPTION = {
  /**
   * File size filtering thresholds in KB (0 represents no limit).
   */
  size: {
    min: 0,
    max: 0,
  },

  /**
   * Granular media scanning filters.
   */
  scanFilters: {
    categories: {
      videos: true,
      audio: true,
      files: true
    },
    subCategories: {
      video: true,
      audio: true,
      images: true,
      pdf: true,
      docs: true,
      sheets: true,
      slides: true,
      archives: true,
      disks: true
    },
    formats: {
      // Video
      m3u8: true,
      m3u: true,
      mp4: true,
      webm: true,
      mkv: true,
      flv: true,
      mov: true,
      avi: true,
      wmv: true,
      ts: true,
      // Audio
      mp3: true,
      m4a: true,
      aac: true,
      wav: true,
      ogg: true,
      flac: true,
      wma: true,
      opus: true,
      // Images
      png: true,
      jpg: true,
      jpeg: true,
      webp: true,
      gif: true,
      svg: true,
      bmp: true,
      ico: true,
      tiff: true,
      avif: true,
      // Documents & PDFs
      pdf: true,
      doc: true,
      docx: true,
      txt: true,
      rtf: true,
      odt: true,
      epub: true,
      pages: true,
      // Spreadsheets
      xls: true,
      xlsx: true,
      csv: true,
      ods: true,
      numbers: true,
      // Presentations
      ppt: true,
      pptx: true,
      odp: true,
      key: true,
      // Archives
      zip: true,
      "7z": true,
      rar: true,
      tar: true,
      gz: true,
      bz2: true,
      xz: true,
      // Disk Images
      iso: true,
      img: true,
      bin: true,
      dmg: true
    }
  },

  /**
   * Parallel download worker count (2 to 16).
   */
  concurrency: 6,

  /**
   * Segment download retry attempts on network failure.
   */
  retries: 3,

  /**
   * Retain captured media items in session storage across navigations.
   */
  keepHistory: true,

  /**
   * Restrict popup view to media originating from the active tab.
   */
  currentTabOnly: false,

  /**
   * Domain blacklist for filtering out unwanted resources.
   */
  domain: [],



  /**
   * Service documentation and update endpoint.
   */
  site: "https://fetchstream.in",

  /**
   * Browser-based upload configuration.
   */
  upload: {
    service: "local",
    credentials: {},
    customList: ["gofile.io", "buzzheavier.com"]
  },

  /**
   * Cloud runner configuration for remote uploads.
   */
  serverUpload: {
    relayUrl: "",
    apiKey: "",
    service: "gofile.io",
    customList: ["gofile.io", "buzzheavier.com"],
    useFallbackProxy: true
  }
};
