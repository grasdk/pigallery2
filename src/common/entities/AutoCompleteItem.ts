import {SearchQueryTypes} from './SearchQueryDTO';

export interface IAutoCompleteItem {
  value: string;
  type?: SearchQueryTypes;
}

export class AutoCompleteItem implements IAutoCompleteItem {
  constructor(public value: string, public type: SearchQueryTypes = null) {
  }

  equals(other: AutoCompleteItem): boolean {
    return this.value === other.value && this.type === other.type;
  }
}

