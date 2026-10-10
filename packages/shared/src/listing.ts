/** What a buyer is looking at: the event and the seats. Price lives in the pricing service. */
export interface Listing {
  id: string;
  eventName: string;
  venue: string;
  /** ISO timestamp of the event start. */
  date: string;
  /** IANA zone of the venue (e.g. "America/Los_Angeles"); the date is shown in this zone, not the viewer's. */
  timeZone?: string;
  section: string;
  row: string;
  seats: string[];
}
