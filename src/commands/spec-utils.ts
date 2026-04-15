export type QuestionCategory = {
  name: string;
  questions: string[];
};

export function parseQuestionsFile(text: string): QuestionCategory[] {
  const categories: QuestionCategory[] = [];
  let current: QuestionCategory | null = null;

  for (const line of text.split("\n")) {
    const heading = line.match(/^##\s+(.+)/);
    if (heading) {
      current = { name: heading[1].trim(), questions: [] };
      categories.push(current);
      continue;
    }
    const question = line.match(/^\d+\.\s+(.+)/);
    if (question && current) {
      current.questions.push(question[1].trim());
    }
  }

  return categories;
}

export function formatAnswers(
  answers: Record<string, string[]>,
  categories: QuestionCategory[],
): string {
  return categories
    .map(cat => {
      const catAnswers = answers[cat.name] ?? [];
      const lines = [`## ${cat.name}`, ""];
      cat.questions.forEach((q, i) => {
        lines.push(`${i + 1}. ${q}`);
        lines.push(`   Answer: ${catAnswers[i] ?? "(no answer)"}`);
        lines.push("");
      });
      return lines.join("\n");
    })
    .join("\n");
}
