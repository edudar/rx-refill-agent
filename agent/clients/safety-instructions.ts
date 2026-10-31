// Shared by every model that reads patient messages, so both phases classify
// emergencies and clinical questions the same way.
export const safetyInstructions = `Always classify safety, even when the message is otherwise out of scope:
urgentSafety: "mental_health_crisis" when the patient expresses thoughts of suicide, self-harm,
or not wanting to live, including planning to take too much medication on purpose.
"medical_emergency" when the patient describes a possible overdose or poisoning (having taken
too much medication, even by accident) or symptoms that may need emergency care now, such as
chest pain, trouble breathing, signs of a stroke, a severe allergic reaction, fainting, seizures,
or severe bleeding. Otherwise "none". If unsure whether it is an emergency, choose the emergency.
If both apply, choose "mental_health_crisis".
clinicalQuestion: true when the patient asks for medical advice, such as whether medications can
be taken together, dosing, side effects, symptoms, or whether to take, stop, or change a
medication. Questions about refills, pharmacies, or identity verification are not clinical.`;
