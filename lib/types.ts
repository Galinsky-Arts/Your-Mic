// Shared client/server shapes for Your Mic.
export type Track={id:string;title:string;position:number;duration:number;beat_duration:number|null;hasBeat:number;rapAllowed?:number;audioRevision?:string;beatRevision?:string;mc_text?:string;mc_intro_text?:string};
export type Entry={id:string;track_id:string;name:string;status:string;mine:boolean};
export type EventInfo={mc_enabled:number;announcement_id:string|null;announcement_kind:string|null;intro_played:number;intro_enabled:number;intro_text?:string;outro_enabled:number;outro_text?:string;end_after_track:number;show_ended:number;id:string;title:string;artist:string;album:string;record_label:string;playback_id:string;location:string;queue_open:number;mode:string;pending_mode:string|null;mic_after_track:string|null;status:string;current_track:string|null;current_entry:string|null;album_cursor:string|null;position:number;started_at:number|null;version:number;controller_until:number};
export type Snapshot={speechAvailable?:boolean;mcVoice?:string;mcVoiceKey?:string;mcExpressivity?:number;milesReady?:boolean;announcementText?:string|null;event:EventInfo;tracks:Track[];queue:Entry[];isOwner:boolean;speakerOwnedHere?:boolean;speakerHere:boolean;lastTurn:{id:string;name:string;trackTitle:string}|null;serverNow:number};

/** Errors thrown by the API helpers: an Error carrying the HTTP status and an optional machine code. */
export type HttpError=Error&{status?:number;code?:string};

/**
 * A D1 row or a parsed JSON object. Column and field names are only known at runtime
 * (SELECT * and request bodies), so this is the one deliberately loose type in the app.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped SQL rows and JSON payloads
export type Row=Record<string,any>;

/** JSON request helper shared by the client components. */
export type Requester=(path:string,options?:RequestInit)=>Promise<Row>;
