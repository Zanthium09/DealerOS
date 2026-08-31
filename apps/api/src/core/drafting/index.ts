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
  render,
  renderVariable,
  containsFinancialTerms,
  placeholdersIn,
} from './variables';
export type { Template, DraftVariable, DraftVariables } from './variables';
