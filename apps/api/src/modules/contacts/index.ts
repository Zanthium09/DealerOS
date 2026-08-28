export { ContactsModule } from './contacts.module';
export { DedupService, FUZZY_THRESHOLD } from './dedup.service';
export type { DedupMatch } from './dedup.service';
export { ImportService } from './import.service';
export type { BatchPreview, ImportResult, StartBatchInput } from './import.service';
export { MergeService } from './merge.service';
export { parseFile } from './parse';
export type { Parsed, Row } from './parse';
export {
  IMPORT_FIELDS,
  dedupeKeyFor,
  normalizeEmail,
  normalizePhone,
  normalizeRow,
  suggestMapping,
} from './normalize';
export type { ColumnMapping, ImportField, NormalizedRow } from './normalize';
