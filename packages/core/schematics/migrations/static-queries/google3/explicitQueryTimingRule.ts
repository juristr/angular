/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {Replacement, RuleFailure, Rules} from 'tslint';
import * as ts from 'typescript';

import {NgComponentTemplateVisitor} from '../../../utils/ng_component_template';
import {visitAllNodes} from '../../../utils/typescript/visit_nodes';
import {analyzeNgQueryUsage} from '../angular/analyze_query_usage';
import {NgQueryResolveVisitor} from '../angular/ng_query_visitor';
import {QueryTiming} from '../angular/query-definition';
import {getTransformedQueryCallExpr} from '../transform';

const FAILURE_MESSAGE = 'Query does not explicitly specify its timing. Read more here: ' +
    'https://github.com/angular/angular/pull/28810';

/**
 * Rule that reports if an Angular "ViewChild" or "ContentChild" query is not explicitly
 * specifying its timing. The rule also provides TSLint automatic replacements that can
 * be applied in order to automatically migrate to the explicit query timing API.
 */
export class Rule extends Rules.TypedRule {
  applyWithProgram(sourceFile: ts.SourceFile, program: ts.Program): RuleFailure[] {
    const typeChecker = program.getTypeChecker();
    const queryVisitor = new NgQueryResolveVisitor(program.getTypeChecker());
    const templateVisitor = new NgComponentTemplateVisitor(typeChecker);
    const rootSourceFiles = program.getRootFileNames().map(f => program.getSourceFile(f) !);
    const printer = ts.createPrinter();
    const failures: RuleFailure[] = [];

    // Analyze source files by detecting queries, class relations and component templates.
    rootSourceFiles.forEach(sourceFile => {
      // The visit utility function only traverses the source file once. We don't want to
      // traverse through all source files multiple times for each visitor as this could be
      // slow.
      visitAllNodes(sourceFile, [queryVisitor, templateVisitor]);
    });

    const {resolvedQueries, classMetadata} = queryVisitor;

    // Add all resolved templates to the class metadata so that we can also
    // check component templates for static query usage.
    templateVisitor.resolvedTemplates.forEach(template => {
      if (classMetadata.has(template.container)) {
        classMetadata.get(template.container) !.template = template;
      }
    });

    const queries = resolvedQueries.get(sourceFile);

    // No queries detected for the given source file.
    if (!queries) {
      return [];
    }

    // Compute the query usage for all resolved queries and update the
    // query definitions to explicitly declare the query timing (static or dynamic)
    queries.forEach(q => {
      const queryExpr = q.decorator.node.expression;
      const timing = analyzeNgQueryUsage(q, classMetadata, typeChecker);
      const transformedNode = getTransformedQueryCallExpr(q, timing);

      if (!transformedNode) {
        return;
      }

      const newText = printer.printNode(ts.EmitHint.Unspecified, transformedNode, sourceFile);

      // Replace the existing query decorator call expression with the
      // updated call expression node.
      const fix = new Replacement(queryExpr.getStart(), queryExpr.getWidth(), newText);
      const failureMessage = `${FAILURE_MESSAGE}. Based on analysis of the query it can be ` +
          `marked as "{static: ${(timing === QueryTiming.STATIC).toString()}}".`;

      failures.push(new RuleFailure(
          sourceFile, queryExpr.getStart(), queryExpr.getEnd(), failureMessage, this.ruleName,
          fix));
    });

    return failures;
  }
}
