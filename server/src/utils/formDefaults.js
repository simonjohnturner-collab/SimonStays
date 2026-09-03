// Starter questions for each form type. These are just defaults — the host edits
// and reorders them in the admin (they're stored as FormTemplate.fields JSON).
// Field types the renderer understands:
//   text | textarea | number | money | select | checkbox | date | rating | photos

const TYPES = ['damage', 'clean'];

const DEFAULTS = {
  damage: {
    title: 'Report an issue',
    description: 'Found something damaged or not properly cleaned? Tell us and add photos so we can fix it fast.',
    fields: [
      { id: 'd_what', label: 'What did you find?', type: 'textarea', required: true },
      { id: 'd_where', label: 'Where in the property is it?', type: 'text', required: false },
      { id: 'd_severity', label: 'How urgent is it?', type: 'select', required: false, options: ['Minor', 'Moderate', 'Urgent'] },
      { id: 'd_photos', label: 'Photos of the issue', type: 'photos', required: false },
    ],
  },
  clean: {
    title: 'Checkout clean report',
    description: 'Confirm the unit is cleaned and checked, and log any purchases or meter readings.',
    fields: [
      { id: 'c_done', label: 'Cleaned and checked everything', type: 'checkbox', required: true },
      { id: 'c_notes', label: 'Anything to flag (damage, missing items)?', type: 'textarea', required: false },
      { id: 'c_electricity', label: 'Electricity balance left on the meter', type: 'text', required: false },
      { id: 'c_purchases', label: 'Items purchased (name & cost)', type: 'textarea', required: false },
      { id: 'c_photos', label: 'Photos & proof of purchase', type: 'photos', required: false },
    ],
  },
};

function defaultTemplate(type) {
  const d = DEFAULTS[type] || { title: 'Form', description: '', fields: [] };
  return { type, title: d.title, description: d.description, fields: d.fields, active: true };
}

module.exports = { TYPES, defaultTemplate };
