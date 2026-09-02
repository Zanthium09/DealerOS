export { DraftingModule } from './drafting.module';
export { DraftingService } from './drafting.service';
export type { DraftRequest } from './drafting.service';
export {
  DraftingError,
  template,
  money,
  quantity,
  percent,
  date,
  text,
  name,
  render,
  renderVariable,
  containsFinancialTerms,
  placeholdersIn,
  assertNoDigits,
} from './variables';
export type { Template, DraftVariable, DraftVariables } from './variables';
