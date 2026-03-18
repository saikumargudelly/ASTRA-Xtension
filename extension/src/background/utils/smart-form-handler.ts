// ════════════════════════════════════════════════════════════════════════════
// ASTRA Smart Form Handling
// ─ Intelligent date picker detection & interaction
// ─ Rich text editor support (TinyMCE, Quill, etc.)
// ─ Multi-select dropdown handling
// ─ Password fields, autocomplete, file uploads
// ════════════════════════════════════════════════════════════════════════════

export type FormFieldType =
    | 'text'
    | 'password'
    | 'email'
    | 'number'
    | 'date'
    | 'datetime'
    | 'select'
    | 'multiselect'
    | 'checkbox'
    | 'radio'
    | 'textarea'
    | 'richtext'
    | 'autocomplete'
    | 'file'
    | 'other';

export interface FormField {
    selector: string;
    value: string | string[];
    type?: FormFieldType;
    label?: string;
    required?: boolean;
    // Date-specific
    dateFormat?: 'YYYY-MM-DD' | 'MM/DD/YYYY' | 'DD/MM/YYYY' | 'unix' | 'iso';
    // Rich text options
    editorType?: 'tinymce' | 'quill' | 'contenteditable' | 'draft-js';
    // Multi-select options
    multiple?: boolean;
}

export interface FormFillResult {
    success: boolean;
    filledFields: number;
    failedFields: string[];
    errors: Record<string, string>;
}

/**
 * Detect if element is a date picker.
 */
export function isDatePickerField(element: Element): boolean {
    if (element instanceof HTMLInputElement) {
        return element.type === 'date' || element.type === 'datetime-local';
    }

    const className = element.className.toString().toLowerCase();
    const dataAttr = element.getAttribute('data-type')?.toLowerCase() ?? '';

    return (
        className.includes('date') ||
        className.includes('calendar') ||
        dataAttr.includes('date')
    );
}

/**
 * Detect date picker format from input attributes.
 */
export function detectDateFormat(element: Element): FormField['dateFormat'] {
    if (element instanceof HTMLInputElement) {
        const placeholder = element.placeholder?.toLowerCase() ?? '';
        if (placeholder.includes('mm/dd/yyyy')) return 'MM/DD/YYYY';
        if (placeholder.includes('dd/mm/yyyy')) return 'DD/MM/YYYY';
        if (placeholder.includes('yyyy-mm-dd')) return 'YYYY-MM-DD';
    }

    const dataFormat = element.getAttribute('data-format')?.toLowerCase() ?? '';
    if (dataFormat.includes('mm')) return 'MM/DD/YYYY';
    if (dataFormat.includes('dd')) return 'DD/MM/YYYY';

    return 'YYYY-MM-DD'; // Default ISO format
}

/**
 * Format date for input based on detected format.
 */
export function formatDateForInput(dateValue: string, format: FormField['dateFormat']): string {
    try {
        const date = new Date(dateValue);
        if (isNaN(date.getTime())) return dateValue;

        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');

        switch (format) {
            case 'MM/DD/YYYY':
                return `${month}/${day}/${year}`;
            case 'DD/MM/YYYY':
                return `${day}/${month}/${year}`;
            case 'unix':
                return String(Math.floor(date.getTime() / 1000));
            case 'iso':
                return date.toISOString();
            case 'YYYY-MM-DD':
            default:
                return `${year}-${month}-${day}`;
        }
    } catch {
        return dateValue;
    }
}

/**
 * Detect if element is a rich text editor.
 */
export function isRichTextEditor(element: Element): boolean {
    // TinyMCE
    if ((window as any).tinymce?.get && element.id) {
        return !!(window as any).tinymce.get(element.id);
    }

    // Quill
    if ((window as any).Quill && element.classList.contains('ql-container')) {
        return true;
    }

    // Draft.js (common pattern)
    if (element.classList.contains('DraftEditor-root')) {
        return true;
    }

    // Contenteditable
    if ((element as HTMLElement).contentEditable === 'true') {
        return true;
    }

    // Check for common editor markers
    const className = element.className.toString().toLowerCase();
    return (
        className.includes('editor') ||
        className.includes('richtexteditor') ||
        className.includes('wysiwyg') ||
        className.includes('trix-editor')
    );
}

/**
 * Detect which rich text editor is used.
 */
export function detectEditorType(element: Element): FormField['editorType'] {
    if ((window as any).tinymce?.get && element.id) {
        return 'tinymce';
    }

    if ((window as any).Quill && element.classList.contains('ql-container')) {
        return 'quill';
    }

    if (element.classList.contains('DraftEditor-root')) {
        return 'draft-js';
    }

    if ((element as HTMLElement).contentEditable === 'true') {
        return 'contenteditable';
    }

    return 'contenteditable'; // Default fallback
}

/**
 * Set text in rich text editor.
 */
export async function setRichTextValue(
    element: Element,
    value: string,
    editorType?: FormField['editorType'],
    sleep: (ms: number) => Promise<void> = (ms) =>
        new Promise(r => setTimeout(r, ms)),
): Promise<void> {
    const type = editorType ?? detectEditorType(element);

    switch (type) {
        case 'tinymce': {
            if (element.id && (window as any).tinymce?.get) {
                const editor = (window as any).tinymce.get(element.id);
                if (editor) {
                    editor.setContent(value);
                    await sleep(500);
                }
            }
            break;
        }

        case 'quill': {
            if ((window as any).Quill) {
                // Find the Quill instance
                const editorContainer = element as any;
                if (editorContainer.__quill) {
                    editorContainer.__quill.setContents([{ insert: value }]);
                    await sleep(500);
                }
            }
            break;
        }

        case 'contenteditable': {
            element.innerHTML = value;
            element.textContent = value;
            const event = new Event('input', { bubbles: true });
            element.dispatchEvent(event);
            await sleep(300);
            break;
        }

        case 'draft-js': {
            // Draft.js is complex; fallback to contenteditable approach
            const editable = element.querySelector('[contenteditable="true"]');
            if (editable) {
                editable.textContent = value;
                const event = new Event('input', { bubbles: true });
                editable.dispatchEvent(event);
                await sleep(300);
            }
            break;
        }
    }
}

/**
 * Detect if element is a multi-select field.
 */
export function isMultiSelectField(element: Element): boolean {
    if (element instanceof HTMLSelectElement) {
        return element.multiple;
    }

    const className = element.className.toString().toLowerCase();
    return (
        className.includes('multiselect') ||
        className.includes('multi-select') ||
        className.includes('select-multiple')
    );
}

/**
 * Handle autocompletion in text fields.
 */
export async function fillAutocompleteField(
    element: Element,
    value: string,
    sleep: (ms: number) => Promise<void> = (ms) =>
        new Promise(r => setTimeout(r, ms)),
): Promise<boolean> {
    if (!(element instanceof HTMLInputElement)) {
        return false;
    }

    // Focus field
    element.focus();
    await sleep(200);

    // Type text
    element.value = '';
    element.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(300);

    // Type character by character to trigger autocomplete
    for (const char of value) {
        element.value += char;
        element.dispatchEvent(new KeyboardEvent('keydown', { key: char }));
        element.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(50);
    }

    // Wait for suggestions
    await sleep(500);

    // Try to find and click first suggestion
    const suggestions = document.querySelectorAll('[role="option"], .autocomplete-suggestion, .autocomplete li');
    if (suggestions.length > 0) {
        (suggestions[0] as HTMLElement).click();
        await sleep(300);
        return true;
    }

    // Press Enter to confirm
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    element.dispatchEvent(new Event('change', { bubbles: true }));

    return false;
}

/**
 * Smart form fill with support for complex field types.
 */
export async function smartFillForm(
    fields: FormField[],
    options: {
        sleep?: (ms: number) => Promise<void>;
        throwOnFirstError?: boolean;
    } = {},
): Promise<FormFillResult> {
    const { sleep: sleepFn = (ms) => new Promise(r => setTimeout(r, ms)), throwOnFirstError = false } = options;

    const result: FormFillResult = {
        success: true,
        filledFields: 0,
        failedFields: [],
        errors: {},
    };

    for (const field of fields) {
        try {
            const element = document.querySelector(field.selector) as HTMLElement;
            if (!element) {
                result.errors[field.selector] = 'Element not found';
                result.failedFields.push(field.selector);
                if (throwOnFirstError) throw new Error(`Field not found: ${field.selector}`);
                continue;
            }

            const type = field.type ?? detectFieldType(element);

            switch (type) {
                case 'date': {
                    const dateFormat = field.dateFormat ?? detectDateFormat(element);
                    const formatted = formatDateForInput(String(field.value), dateFormat);
                    if (element instanceof HTMLInputElement) {
                        element.value = formatted;
                        element.dispatchEvent(new Event('change', { bubbles: true }));
                        await sleepFn(200);
                    }
                    break;
                }

                case 'richtext': {
                    await setRichTextValue(element, String(field.value), field.editorType, sleepFn);
                    break;
                }

                case 'autocomplete': {
                    const success = await fillAutocompleteField(element, String(field.value), sleepFn);
                    if (!success && element instanceof HTMLInputElement) {
                        element.value = String(field.value);
                        element.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                    break;
                }

                case 'select': {
                    if (element instanceof HTMLSelectElement) {
                        element.value = String(field.value);
                        element.dispatchEvent(new Event('change', { bubbles: true }));
                        await sleepFn(200);
                    }
                    break;
                }

                case 'multiselect': {
                    const values = Array.isArray(field.value) ? field.value : [field.value];
                    if (element instanceof HTMLSelectElement) {
                        for (const val of values) {
                            const option = element.querySelector(`option[value="${val}"]`);
                            if (option instanceof HTMLOptionElement) {
                                option.selected = true;
                            }
                        }
                        element.dispatchEvent(new Event('change', { bubbles: true }));
                        await sleepFn(200);
                    }
                    break;
                }

                case 'checkbox': {
                    if (element instanceof HTMLInputElement && element.type === 'checkbox') {
                        const shouldCheck = String(field.value).toLowerCase() === 'true' || String(field.value) === '1';
                        element.checked = shouldCheck;
                        element.dispatchEvent(new Event('change', { bubbles: true }));
                        await sleepFn(200);
                    }
                    break;
                }

                case 'password': {
                    if (element instanceof HTMLInputElement) {
                        element.value = String(field.value);
                        element.dispatchEvent(new Event('input', { bubbles: true }));
                        element.dispatchEvent(new Event('change', { bubbles: true }));
                        await sleepFn(200);
                    }
                    break;
                }

                case 'text':
                case 'email':
                case 'textarea':
                default: {
                    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
                        element.value = String(field.value);
                        element.dispatchEvent(new Event('input', { bubbles: true }));
                        element.dispatchEvent(new Event('change', { bubbles: true }));
                        await sleepFn(200);
                    }
                    break;
                }
            }

            result.filledFields++;
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            result.errors[field.selector] = errorMsg;
            result.failedFields.push(field.selector);
            result.success = false;
            if (throwOnFirstError) throw err;
        }
    }

    return result;
}

/**
 * Detect field type from element.
 */
export function detectFieldType(element: Element): FormFieldType {
    if (element instanceof HTMLInputElement) {
        switch (element.type) {
            case 'date':
            case 'datetime-local':
                return 'date';
            case 'email':
                return 'email';
            case 'number':
                return 'number';
            case 'password':
                return 'password';
            case 'checkbox':
                return 'checkbox';
            case 'radio':
                return 'radio';
            case 'file':
                return 'file';
            default:
                return 'text';
        }
    }

    if (element instanceof HTMLTextAreaElement) {
        return 'textarea';
    }

    if (element instanceof HTMLSelectElement) {
        return element.multiple ? 'multiselect' : 'select';
    }

    if (isRichTextEditor(element)) {
        return 'richtext';
    }

    if (isDatePickerField(element)) {
        return 'date';
    }

    if (isMultiSelectField(element)) {
        return 'multiselect';
    }

    const className = element.className.toString().toLowerCase();
    if (className.includes('autocomplete')) {
        return 'autocomplete';
    }

    return 'other';
}
