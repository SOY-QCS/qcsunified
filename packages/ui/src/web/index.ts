// Web-only components (Next.js apps). Phone apps must not import this file.
export { QcsMap, loadGoogle, type MapPin } from "./map";
export { TrackView } from "./track-view";
export { ConfirmView } from "./confirm-view";
export { BarList, HeatGrid, Kpi, LineChart, StackedBars, type StackRow } from "./charts";
export { FORMATS, SERVICE_SERIES, fmtGhs, fmtHours, fmtInt, fmtMins, fmtPct, type FmtName } from "./format";
