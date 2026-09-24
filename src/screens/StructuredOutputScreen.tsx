/**
 * StructuredOutputScreen - reproduces comparison.md §5.
 *
 * RunAnywhere compiles the JSON Schema to GBNF in json_schema_to_gbnf.cpp.
 * That compiler makes every property required, whatever `required` says
 * (:123-133), sorts keys alphabetically, and drops minimum/maximum/minItems.
 * With `nickname` left out of `required`, the model is still forced to invent
 * one, and the keys come back sorted instead of in declared order. The screen
 * shows what RunAnywhere returned, then what it should be.
 */

import React, { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { RunAnywhere } from '@runanywhere/core';
import { AppColors } from '../theme';
import { useModelService, MODEL_CREDITS } from '../services/ModelService';
import { ModelLoaderWidget, ActionButton, FindingHeader, ResultCard, formatJson } from '../components';

const ACCENT = AppColors.accentGreen;

const SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    name: { type: 'string' },
    age: { type: 'integer', minimum: 0, maximum: 130 },
    nickname: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' }, minItems: 1 },
  },
  required: ['name', 'age', 'tags'],
});

const PROMPT = 'Give me a short JSON profile of Ada Lovelace. Only include a nickname if she had a well-known one.';

const EXPECTED = `
// age & tags can be anything
{
  "name": "Ada Lovelace",
  "age": 36,
  "tags": [
    "mathematician",
    "programmer"
  ]
}`;

const VALIDATION_ISSUES = `
What is wrong?
- Nickname should not have been defined (see prompt).
- Key order is alphabetical, the schema is not
`;

export const StructuredOutputScreen: React.FC = () => {
  const modelService = useModelService();
  const [output, setOutput] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  const runValidation = async () => {
    setIsRunning(true);
    setOutput(null);
    try {
      const result = await RunAnywhere.llm.generateStructured(
        PROMPT,
        SCHEMA,
        { temperature: 0.1 },
        'validationOnly',
      );
      console.log(result);
      setOutput(`Result:\n${formatJson(result.raw || result.text)}\n${VALIDATION_ISSUES}`);
    } catch (e) {
      setOutput(`Error: ${String(e)}`);
    } finally {
      setIsRunning(false);
    }
  };

  if (!modelService.isLLMLoaded) {
    return (
      <ModelLoaderWidget
        modelCredit={MODEL_CREDITS.llm}
        title="LLM Model Required"
        subtitle="Load a language model to test structured output"
        icon="chat"
        accentColor={ACCENT}
        isDownloading={modelService.isLLMDownloading}
        isLoading={modelService.isLLMLoading}
        progress={modelService.llmDownloadProgress}
        onLoad={modelService.downloadAndLoadLLM}
      />
    );
  }

  return (
    <ScrollView style={styles.screenContainer} contentContainerStyle={styles.contentContainer}>
      <FindingHeader
        title="`required` is ignored"
        claim={
          'RunAnywhere\'s schema-to-grammar compiler makes every property mandatory and ' +
          'sorts keys alphabetically. An optional field has to be filled in anyway.'
        }
      />

      <ResultCard title="Prompt" body={PROMPT} />
        <ResultCard title="Schema" body={formatJson(SCHEMA)} mono />

      <View style={styles.result}>
        <ActionButton label="Run Validation" onPress={runValidation} busy={isRunning} accentColor={ACCENT} />
      </View>


      {output !== null && (
        <View style={styles.result}>
          <ResultCard title="RunAnywhere result" body={output} mono />
          <ResultCard title="Expected result" body={EXPECTED} mono />
        </View>
      )}
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  screenContainer: {
    flex: 1,
    backgroundColor: AppColors.primaryDark,
  },
  contentContainer: {
    padding: 16,
    paddingBottom: 40,
  },
  result: {
    paddingBottom: 40,
  },
});
