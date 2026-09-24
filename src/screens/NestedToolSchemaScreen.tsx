/**
 * NestedToolSchemaScreen - reproduces comparison.md §4.
 *
 * RunAnywhere writes the tool list into the prompt as a flat parameter list
 * (tool_calling.cpp), so a nested schema reaches the model as
 * `when: object` and `attendees: array` with no fields. The screen shows what
 * RunAnywhere returned, then what it should be.
 */

import React, { useState } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { RunAnywhere, generateWithTools } from '@runanywhere/core';
import type { ToolCallingResult } from '@runanywhere/core';
import { ToolDefinition } from '@runanywhere/proto-ts/tool_calling';
import { AppColors } from '../theme';
import { useModelService, MODEL_CREDITS } from '../services/ModelService';
import { ModelLoaderWidget, ActionButton, FindingHeader, ResultCard, formatJson } from '../components';

const ACCENT = AppColors.accentPink;

const NESTED_TOOL = ToolDefinition.fromPartial({
  name: 'create_event',
  description: 'Creates a calendar event',
  parameters: JSON.stringify({
    type: 'object',
    properties: {
      title: { type: 'string' },
      when: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'YYYY-MM-DD' },
          start: { type: 'string', description: 'HH:MM' },
          end: { type: 'string', description: 'HH:MM' },
        },
        required: ['date', 'start'],
      },
      attendees: {
        type: 'array',
        items: {
          type: 'object',
          properties: { name: { type: 'string' }, email: { type: 'string' } },
          required: ['name', 'email'],
        },
      },
      priority: { type: 'integer', minimum: 1, maximum: 5 },
    },
    required: ['title', 'when'],
  }),
});

const NESTED_PROMPT =
  'Create an event called "Design review" on 2026-10-02 from 14:00 to 15:00 with ' +
  'Ada (ada@example.com) and Alan (alan@example.com).';

const NESTED_EXPECTED = `create_event
{
  "title": "Design review",
  "when": {
    "date": "2026-10-02",
    "start": "14:00",
    "end": "15:00"
  },
  "attendees": [
    { "name": "Ada", "email": "ada@example.com" },
    { "name": "Alan", "email": "alan@example.com" }
  ]
}`;

/** What RunAnywhere returned: the first tool call, or the text when there is none. */
const describeResult = (result: ToolCallingResult): string => {
  const call = result.toolCalls[0];
  if (!call) {
    return `No tool call. Text:\n${result.text || '(empty)'}`;
  }
  return `${call.name}\n${formatJson(call.argumentsJson)}`;
};

export const NestedToolSchemaScreen: React.FC = () => {
  const modelService = useModelService();
  const [output, setOutput] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  const runNested = async () => {
    setIsRunning(true);
    setOutput(null);
    try {
      await RunAnywhere.llm.tools.clear();
      await RunAnywhere.llm.tools.register(NESTED_TOOL, async () => ({ ok: true }));
      const result = await generateWithTools(NESTED_PROMPT, {
        tools: [NESTED_TOOL]
      });
      console.log(result);
      setOutput(describeResult(result));
    } catch (e) {
      setOutput(`Error: ${String(e)}`);
    } finally {
      await RunAnywhere.llm.tools.clear().catch(() => {});
      setIsRunning(false);
    }
  };

  if (!modelService.isLLMLoaded) {
    return (
      <ModelLoaderWidget
        modelCredit={MODEL_CREDITS.llm}
        title="LLM Model Required"
        subtitle="Load a language model to test tool schemas"
        icon="tools"
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
        title="Nested tool schemas are flattened"
        claim={
          'RunAnywhere describes tools to the model as a flat list, so `when` becomes a bare ' +
          '"object" and `attendees` a bare "array". The model has to guess the shape.'
        }
      />

      <ResultCard title="Nested schema (create_event)" body={NESTED_PROMPT} />
      <ActionButton
        label="Run nested"
        onPress={runNested}
        busy={isRunning}
        accentColor={ACCENT}
      />
      {output !== null && (
        <>
          <ResultCard title="RunAnywhere result" body={output} mono />
          <ResultCard title="Expected result" body={NESTED_EXPECTED} mono />
        </>
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
});
