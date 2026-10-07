/**
 * StructuredOutputScreen - reproduces comparison.md §5.
 *
 * RunAnywhere compiles the JSON Schema to GBNF in json_schema_to_gbnf.cpp.
 * That compiler makes every property required, whatever `required` says
 * (:123-133), sorts keys alphabetically, and drops minimum/maximum/minItems.
 *
 * The screen asks both engines for the required fields only, the way a caller
 * would. NobodyWho's llguidance lets the model stop after `tags`; RunAnywhere's
 * grammar has no path that does, so it has to sort the keys and invent a
 * nickname.
 */

import React, { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { RunAnywhere } from '@runanywhere/core';
import { Chat as NWChat, SamplerConfig, SamplerPresets } from 'react-native-nobodywho';
import { AppColors } from '../theme';
import { useModelService, MODEL_CREDITS, MODEL_IDS } from '../services/ModelService';
import { ModelLoaderWidget, ActionButton, FindingHeader, ResultCard, formatJson } from '../components';
import type { Verdict } from '../components';

const ACCENT = AppColors.accentGreen;
const MODEL_ID = MODEL_IDS.llm;

//RunAnywhere's own defaults at temperature 0.1, pinned so NobodyWho/RA can match
const SAMPLING = {
  temperature: 0.1,
  topK: 40,
  topP: 1,
  minP: 0.05,
  repetitionPenalty: 1.1,
  frequencyPenalty: 0,
  presencePenalty: 0,
} as const;

const SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    name: { type: 'string' },
    age: { type: 'integer', minimum: 0, maximum: 130 },
    tags: { type: 'array', items: { type: 'string' }, minItems: 1 },
    nickname: { type: 'string' },
  },
  required: ['name', 'age', 'tags'],
});

const PROMPT = 'Give me Ada Lovelace as JSON with name, age and tags fields.';

const EXPECTED_KEYS = ['name', 'age', 'tags'];

const nwSchemaSampler = (): SamplerConfig => {
  const config = JSON.parse(SamplerPresets.constrainWithJsonSchema(SCHEMA).toJson());
  config.steps.push(
    {
      type: 'penalties',
      value: {
        penalty_last_n: 64, // Match RunAnywhere, fixed in its backend.
        penalty_repeat: SAMPLING.repetitionPenalty,
        penalty_freq: SAMPLING.frequencyPenalty,
        penalty_present: SAMPLING.presencePenalty,
      },
    },
    { type: 'top_k', value: { top_k: SAMPLING.topK } },
    { type: 'top_p', value: { top_p: SAMPLING.topP, min_keep: 1 } },
    { type: 'min_p', value: { min_p: SAMPLING.minP, min_keep: 1 } },
    { type: 'temperature', value: { temperature: SAMPLING.temperature } },
  );
  return SamplerConfig.fromJson(JSON.stringify(config)) as SamplerConfig;
};

interface Outcome {
  verdict: Verdict;
  body: string;
}

const checkOutput = (raw: string): Outcome => {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { verdict: 'fail', body: `${raw}\n\nNot valid JSON.` };
  }
  const keys = Object.keys(parsed);
  const hasNickname = 'nickname' in parsed;
  const inOrder = keys.join(',') === EXPECTED_KEYS.join(',');
  const lines = [
    hasNickname
      ? `✗ nickname: "${String(parsed.nickname)}" (not asked for)`
      : '✓ nickname: omitted',
    inOrder ? `✓ key order: ${keys.join(', ')}` : `✗ key order: ${keys.join(', ')} (schema: ${EXPECTED_KEYS.join(', ')})`,
  ];
  return {
    verdict: !hasNickname && inOrder ? 'pass' : 'fail',
    body: `${formatJson(raw)}\n\n${lines.join('\n')}`,
  };
};

const errorOutcome = (e: unknown): Outcome => ({ verdict: 'fail', body: `Error: ${String(e)}` });

export const StructuredOutputScreen: React.FC = () => {
  const modelService = useModelService();
  const [output, setOutput] = useState<Outcome | null>(null);
  const [nwOutput, setNWOutput] = useState<Outcome | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  const nwModel = modelService.nwModelId === MODEL_ID ? modelService.nwModel : null;

  /** Ask NobodyWho once, with the schema as an llguidance constraint on a fresh chat. */
  const runNW = async (): Promise<string> => {
    const nwChat = new NWChat({
      model: nwModel!,
      contextSize: 2048, // Match RunAnywhere, fixed in its backend.
      sampler: nwSchemaSampler(),
      templateVariables: { enable_thinking: false },
    });
    try {
      return await nwChat.ask(PROMPT).completed();
    } finally {
      nwChat.destroy();
    }
  };

  const runValidation = async () => {
    setIsRunning(true);
    setOutput(null);
    setNWOutput(null);
    try {
      const result = await RunAnywhere.llm.generateStructured(
        PROMPT,
        SCHEMA,
        { ...SAMPLING, reasoning: { mode: 'off' } },
        'validationOnly',
      );
      const raw = result.raw || result.text;
      console.log('[StructuredOutput] RunAnywhere raw:', raw);
      setOutput(checkOutput(raw));
    } catch (e) {
      setOutput(errorOutcome(e));
    }
    try {
      const nwRaw = await runNW();
      console.log('[StructuredOutput] NobodyWho raw:', nwRaw);
      setNWOutput(checkOutput(nwRaw));
    } catch (e) {
      setNWOutput(errorOutcome(e));
    } finally {
      setIsRunning(false);
    }
  };

  if (modelService.loadedLLMId !== MODEL_ID || !nwModel) {
    const raBusy = modelService.isLLMDownloading || modelService.isLLMLoading;

    return (
      <ModelLoaderWidget
        modelCredit={MODEL_CREDITS.llm}
        title="LLM Model Required"
        subtitle="Load the same model in RunAnywhere and NobodyWho to compare their structured output"
        icon="chat"
        accentColor={ACCENT}
        isDownloading={raBusy ? modelService.isLLMDownloading : modelService.isNWDownloading}
        isLoading={raBusy ? modelService.isLLMLoading : modelService.isNWLoading}
        progress={raBusy ? modelService.llmDownloadProgress : modelService.nwDownloadProgress}
        progressLabel={raBusy ? 'RunAnywhere' : 'NobodyWho'}
        onLoad={async () => {
          if (modelService.loadedLLMId !== MODEL_ID) {
            await modelService.downloadAndLoadLanguageModel(MODEL_ID);
          }
          await modelService.downloadAndLoadNW(MODEL_ID);
        }}
      />
    );
  }

  return (
    <ScrollView style={styles.screenContainer} contentContainerStyle={styles.contentContainer}>
      <FindingHeader
        title="`required` is ignored"
        claim={
          'RunAnywhere\'s schema-to-grammar compiler makes every property mandatory and ' +
          'sorts keys alphabetically.'
        }
      />

      <ResultCard title="Schema" body={formatJson(SCHEMA)} mono />

      <ResultCard title="Prompt" body={PROMPT} />

      <View style={styles.result}>
        <ActionButton label="Run Validation" onPress={runValidation} busy={isRunning} accentColor={ACCENT} />
      </View>

      {output !== null && (
        <View style={styles.result}>
          <ResultCard title="RunAnywhere result" verdict={output.verdict} body={output.body} mono />
          {nwOutput !== null && (
            <ResultCard title="NobodyWho result" verdict={nwOutput.verdict} body={nwOutput.body} mono />
          )}
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
