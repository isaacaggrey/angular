/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {consumerAfterComputation, consumerBeforeComputation, consumerPollProducersForChange, ReactiveNode} from '@angular/core/primitives/signals';

import {RuntimeError, RuntimeErrorCode} from '../../errors';
import {assertDefined, assertEqual} from '../../util/assert';
import {assertLContainer} from '../assert';
import {executeCheckHooks, executeInitAndCheckHooks, incrementInitPhaseFlags} from '../hooks';
import {CONTAINER_HEADER_OFFSET, LContainer, LContainerFlags, MOVED_VIEWS} from '../interfaces/container';
import {ComponentTemplate, RenderFlags} from '../interfaces/definition';
import {CONTEXT, EFFECTS_TO_SCHEDULE, ENVIRONMENT, FLAGS, InitPhaseState, LView, LViewFlags, PARENT, REACTIVE_TEMPLATE_CONSUMER, TVIEW, TView, TViewType} from '../interfaces/view';
import {getOrBorrowReactiveLViewConsumer, maybeReturnReactiveLViewConsumer, ReactiveLViewConsumer} from '../reactive_lview_consumer';
import {enterView, isInCheckNoChangesMode, leaveView, setBindingIndex, setIsInCheckNoChangesMode} from '../state';
import {getFirstLContainer, getNextLContainer} from '../util/view_traversal_utils';
import {getComponentLViewByIndex, isCreationMode, markAncestorsForTraversal, markViewForRefresh, resetPreOrderHookFlags, viewAttachedToChangeDetector} from '../util/view_utils';

import {executeTemplate, executeViewQueryFn, handleError, processHostBindingOpCodes, refreshContentQueries} from './shared';

/**
 * The maximum number of times the change detection traversal will rerun before throwing an error.
 */
const MAXIMUM_REFRESH_RERUNS = 100;

export function detectChangesInternal(lView: LView, notifyErrorHandler = true) {
  const environment = lView[ENVIRONMENT];
  const rendererFactory = environment.rendererFactory;
  const afterRenderEventManager = environment.afterRenderEventManager;

  // Check no changes mode is a dev only mode used to verify that bindings have not changed
  // since they were assigned. We do not want to invoke renderer factory functions in that mode
  // to avoid any possible side-effects.
  const checkNoChangesMode = !!ngDevMode && isInCheckNoChangesMode();

  if (!checkNoChangesMode) {
    rendererFactory.begin?.();
    afterRenderEventManager?.begin();
  }

  try {
    const tView = lView[TVIEW];
    const context = lView[CONTEXT];
    refreshView(tView, lView, tView.template, context);
    detectChangesInViewWhileDirty(lView);
  } catch (error) {
    if (notifyErrorHandler) {
      handleError(lView, error);
    }
    throw error;
  } finally {
    if (!checkNoChangesMode) {
      rendererFactory.end?.();

      // One final flush of the effects queue to catch any effects created in `ngAfterViewInit` or
      // other post-order hooks.
      environment.inlineEffectRunner?.flush();

      // Invoke all callbacks registered via `after*Render`, if needed.
      afterRenderEventManager?.end();
    }
  }
}

function detectChangesInViewWhileDirty(lView: LView) {
  let retries = 0;
  // If after running change detection, this view still needs to be refreshed or there are
  // descendants views that need to be refreshed due to re-dirtying during the change detection
  // run, detect changes on the view again. We run change detection in `Targeted` mode to only
  // refresh views with the `RefreshView` flag.
  while (lView[FLAGS] & (LViewFlags.RefreshView | LViewFlags.HasChildViewsToRefresh) ||
         lView[REACTIVE_TEMPLATE_CONSUMER]?.dirty) {
    if (retries === MAXIMUM_REFRESH_RERUNS) {
      throw new RuntimeError(
          RuntimeErrorCode.INFINITE_CHANGE_DETECTION,
          ngDevMode &&
              'Infinite change detection while trying to refresh views. ' +
                  'There may be components which each cause the other to require a refresh, ' +
                  'causing an infinite loop.');
    }
    retries++;
    // Even if this view is detached, we still detect changes in targeted mode because this was
    // the root of the change detection run.
    detectChangesInView(lView, ChangeDetectionMode.Targeted);
  }
}

export function checkNoChangesInternal(lView: LView, notifyErrorHandler = true) {
  setIsInCheckNoChangesMode(true);
  try {
    detectChangesInternal(lView, notifyErrorHandler);
  } finally {
    setIsInCheckNoChangesMode(false);
  }
}


/**
 * Different modes of traversing the logical view tree during change detection.
 *
 *
 * The change detection traversal algorithm switches between these modes based on various
 * conditions.
 */
const enum ChangeDetectionMode {
  /**
   * In `Global` mode, `Dirty` and `CheckAlways` views are refreshed as well as views with the
   * `RefreshView` flag.
   */
  Global,
  /**
   * In `Targeted` mode, only views with the `RefreshView` flag are refreshed.
   */
  Targeted,
}

/**
 * Processes a view in update mode. This includes a number of steps in a specific order:
 * - executing a template function in update mode;
 * - executing hooks;
 * - refreshing queries;
 * - setting host bindings;
 * - refreshing child (embedded and component) views.
 */

export function refreshView<T>(
    tView: TView, lView: LView, templateFn: ComponentTemplate<{}>|null, context: T) {
  ngDevMode && assertEqual(isCreationMode(lView), false, 'Should be run in update mode');
  const flags = lView[FLAGS];
  if ((flags & LViewFlags.Destroyed) === LViewFlags.Destroyed) return;

  // Check no changes mode is a dev only mode used to verify that bindings have not changed
  // since they were assigned. We do not want to execute lifecycle hooks in that mode.
  const isInCheckNoChangesPass = ngDevMode && isInCheckNoChangesMode();

  !isInCheckNoChangesPass && lView[ENVIRONMENT].inlineEffectRunner?.flush();


  // Start component reactive context
  // - We might already be in a reactive context if this is an embedded view of the host.
  // - We might be descending into a view that needs a consumer.
  enterView(lView);
  let prevConsumer: ReactiveNode|null = null;
  let currentConsumer: ReactiveLViewConsumer|null = null;
  if (!isInCheckNoChangesPass && viewShouldHaveReactiveConsumer(tView)) {
    currentConsumer = getOrBorrowReactiveLViewConsumer(lView);
    prevConsumer = consumerBeforeComputation(currentConsumer);
  }

  try {
    resetPreOrderHookFlags(lView);

    setBindingIndex(tView.bindingStartIndex);
    if (templateFn !== null) {
      executeTemplate(tView, lView, templateFn, RenderFlags.Update, context);
    }

    const hooksInitPhaseCompleted =
        (flags & LViewFlags.InitPhaseStateMask) === InitPhaseState.InitPhaseCompleted;

    // execute pre-order hooks (OnInit, OnChanges, DoCheck)
    // PERF WARNING: do NOT extract this to a separate function without running benchmarks
    if (!isInCheckNoChangesPass) {
      if (hooksInitPhaseCompleted) {
        const preOrderCheckHooks = tView.preOrderCheckHooks;
        if (preOrderCheckHooks !== null) {
          executeCheckHooks(lView, preOrderCheckHooks, null);
        }
      } else {
        const preOrderHooks = tView.preOrderHooks;
        if (preOrderHooks !== null) {
          executeInitAndCheckHooks(lView, preOrderHooks, InitPhaseState.OnInitHooksToBeRun, null);
        }
        incrementInitPhaseFlags(lView, InitPhaseState.OnInitHooksToBeRun);
      }
    }

    // First mark transplanted views that are declared in this lView as needing a refresh at their
    // insertion points. This is needed to avoid the situation where the template is defined in this
    // `LView` but its declaration appears after the insertion component.
    markTransplantedViewsForRefresh(lView);
    detectChangesInEmbeddedViews(lView, ChangeDetectionMode.Global);

    // Content query results must be refreshed before content hooks are called.
    if (tView.contentQueries !== null) {
      refreshContentQueries(tView, lView);
    }

    // execute content hooks (AfterContentInit, AfterContentChecked)
    // PERF WARNING: do NOT extract this to a separate function without running benchmarks
    if (!isInCheckNoChangesPass) {
      if (hooksInitPhaseCompleted) {
        const contentCheckHooks = tView.contentCheckHooks;
        if (contentCheckHooks !== null) {
          executeCheckHooks(lView, contentCheckHooks);
        }
      } else {
        const contentHooks = tView.contentHooks;
        if (contentHooks !== null) {
          executeInitAndCheckHooks(
              lView, contentHooks, InitPhaseState.AfterContentInitHooksToBeRun);
        }
        incrementInitPhaseFlags(lView, InitPhaseState.AfterContentInitHooksToBeRun);
      }
    }

    processHostBindingOpCodes(tView, lView);

    // Refresh child component views.
    const components = tView.components;
    if (components !== null) {
      detectChangesInChildComponents(lView, components, ChangeDetectionMode.Global);
    }

    // View queries must execute after refreshing child components because a template in this view
    // could be inserted in a child component. If the view query executes before child component
    // refresh, the template might not yet be inserted.
    const viewQuery = tView.viewQuery;
    if (viewQuery !== null) {
      executeViewQueryFn<T>(RenderFlags.Update, viewQuery, context);
    }

    // execute view hooks (AfterViewInit, AfterViewChecked)
    // PERF WARNING: do NOT extract this to a separate function without running benchmarks
    if (!isInCheckNoChangesPass) {
      if (hooksInitPhaseCompleted) {
        const viewCheckHooks = tView.viewCheckHooks;
        if (viewCheckHooks !== null) {
          executeCheckHooks(lView, viewCheckHooks);
        }
      } else {
        const viewHooks = tView.viewHooks;
        if (viewHooks !== null) {
          executeInitAndCheckHooks(lView, viewHooks, InitPhaseState.AfterViewInitHooksToBeRun);
        }
        incrementInitPhaseFlags(lView, InitPhaseState.AfterViewInitHooksToBeRun);
      }
    }
    if (tView.firstUpdatePass === true) {
      // We need to make sure that we only flip the flag on successful `refreshView` only
      // Don't do this in `finally` block.
      // If we did this in `finally` block then an exception could block the execution of styling
      // instructions which in turn would be unable to insert themselves into the styling linked
      // list. The result of this would be that if the exception would not be throw on subsequent CD
      // the styling would be unable to process it data and reflect to the DOM.
      tView.firstUpdatePass = false;
    }

    // Schedule any effects that are waiting on the update pass of this view.
    if (lView[EFFECTS_TO_SCHEDULE]) {
      for (const notifyEffect of lView[EFFECTS_TO_SCHEDULE]) {
        notifyEffect();
      }

      // Once they've been run, we can drop the array.
      lView[EFFECTS_TO_SCHEDULE] = null;
    }

    // Do not reset the dirty state when running in check no changes mode. We don't want components
    // to behave differently depending on whether check no changes is enabled or not. For example:
    // Marking an OnPush component as dirty from within the `ngAfterViewInit` hook in order to
    // refresh a `NgClass` binding should work. If we would reset the dirty state in the check
    // no changes cycle, the component would be not be dirty for the next update pass. This would
    // be different in production mode where the component dirty state is not reset.
    if (!isInCheckNoChangesPass) {
      lView[FLAGS] &= ~(LViewFlags.Dirty | LViewFlags.FirstLViewPass);
    }
  } catch (e) {
    // If refreshing a view causes an error, we need to remark the ancestors as needing traversal
    // because the error might have caused a situation where views below the current location are
    // dirty but will be unreachable because the "has dirty children" flag in the ancestors has been
    // cleared during change detection and we failed to run to completion.

    markAncestorsForTraversal(lView);
    throw e;
  } finally {
    if (currentConsumer !== null) {
      consumerAfterComputation(currentConsumer, prevConsumer);
      maybeReturnReactiveLViewConsumer(currentConsumer);
    }
    leaveView();
  }
}

/**
 * Indicates if the view should get its own reactive consumer node.
 *
 * In the current design, all embedded views share a consumer with the component view. This allows
 * us to refresh at the component level rather than at a per-view level. In addition, root views get
 * their own reactive node because root component will have a host view that executes the
 * component's host bindings. This needs to be tracked in a consumer as well.
 *
 * To get a more granular change detection than per-component, all we would just need to update the
 * condition here so that a given view gets a reactive consumer which can become dirty independently
 * from its parent component. For example embedded views for signal components could be created with
 * a new type "SignalEmbeddedView" and the condition here wouldn't even need updating in order to
 * get granular per-view change detection for signal components.
 */
function viewShouldHaveReactiveConsumer(tView: TView) {
  return tView.type !== TViewType.Embedded;
}

/**
 * Goes over embedded views (ones created through ViewContainerRef APIs) and refreshes
 * them by executing an associated template function.
 */
function detectChangesInEmbeddedViews(lView: LView, mode: ChangeDetectionMode) {
  for (let lContainer = getFirstLContainer(lView); lContainer !== null;
       lContainer = getNextLContainer(lContainer)) {
    lContainer[FLAGS] &= ~LContainerFlags.HasChildViewsToRefresh;
    for (let i = CONTAINER_HEADER_OFFSET; i < lContainer.length; i++) {
      const embeddedLView = lContainer[i];
      detectChangesInViewIfAttached(embeddedLView, mode);
    }
  }
}

/**
 * Mark transplanted views as needing to be refreshed at their insertion points.
 *
 * @param lView The `LView` that may have transplanted views.
 */
function markTransplantedViewsForRefresh(lView: LView) {
  for (let lContainer = getFirstLContainer(lView); lContainer !== null;
       lContainer = getNextLContainer(lContainer)) {
    if (!(lContainer[FLAGS] & LContainerFlags.HasTransplantedViews)) continue;

    const movedViews = lContainer[MOVED_VIEWS]!;
    ngDevMode && assertDefined(movedViews, 'Transplanted View flags set but missing MOVED_VIEWS');
    for (let i = 0; i < movedViews.length; i++) {
      const movedLView = movedViews[i]!;
      const insertionLContainer = movedLView[PARENT] as LContainer;
      ngDevMode && assertLContainer(insertionLContainer);
      markViewForRefresh(movedLView);
    }
  }
}

/**
 * Detects changes in a component by entering the component view and processing its bindings,
 * queries, etc. if it is CheckAlways, OnPush and Dirty, etc.
 *
 * @param componentHostIdx  Element index in LView[] (adjusted for HEADER_OFFSET)
 */
function detectChangesInComponent(
    hostLView: LView, componentHostIdx: number, mode: ChangeDetectionMode): void {
  ngDevMode && assertEqual(isCreationMode(hostLView), false, 'Should be run in update mode');
  const componentView = getComponentLViewByIndex(componentHostIdx, hostLView);
  detectChangesInViewIfAttached(componentView, mode);
}

/**
 * Visits a view as part of change detection traversal.
 *
 * If the view is detached, no additional traversal happens.
 */
function detectChangesInViewIfAttached(lView: LView, mode: ChangeDetectionMode) {
  if (!viewAttachedToChangeDetector(lView)) {
    return;
  }
  detectChangesInView(lView, mode);
}

/**
 * Visits a view as part of change detection traversal.
 *
 * The view is refreshed if:
 * - If the view is CheckAlways or Dirty and ChangeDetectionMode is `Global`
 * - If the view has the `RefreshView` flag
 *
 * The view is not refreshed, but descendants are traversed in `ChangeDetectionMode.Targeted` if the
 * view HasChildViewsToRefresh flag is set.
 */
function detectChangesInView(lView: LView, mode: ChangeDetectionMode) {
  const isInCheckNoChangesPass = ngDevMode && isInCheckNoChangesMode();
  const tView = lView[TVIEW];
  const flags = lView[FLAGS];
  const consumer = lView[REACTIVE_TEMPLATE_CONSUMER];

  // Refresh CheckAlways views in Global mode.
  let shouldRefreshView: boolean =
      !!(mode === ChangeDetectionMode.Global && flags & LViewFlags.CheckAlways);

  // Refresh Dirty views in Global mode, as long as we're not in checkNoChanges.
  // CheckNoChanges never worked with `OnPush` components because the `Dirty` flag was
  // cleared before checkNoChanges ran. Because there is now a loop for to check for
  // backwards views, it gives an opportunity for `OnPush` components to be marked `Dirty`
  // before the CheckNoChanges pass. We don't want existing errors that are hidden by the
  // current CheckNoChanges bug to surface when making unrelated changes.
  shouldRefreshView ||= !!(
      flags & LViewFlags.Dirty && mode === ChangeDetectionMode.Global && !isInCheckNoChangesPass);

  // Always refresh views marked for refresh, regardless of mode.
  shouldRefreshView ||= !!(flags & LViewFlags.RefreshView);

  // Refresh views when they have a dirty reactive consumer, regardless of mode.
  shouldRefreshView ||= !!(consumer?.dirty && consumerPollProducersForChange(consumer));

  // Mark the Flags and `ReactiveNode` as not dirty before refreshing the component, so that they
  // can be re-dirtied during the refresh process.
  if (consumer) {
    consumer.dirty = false;
  }
  lView[FLAGS] &= ~(LViewFlags.HasChildViewsToRefresh | LViewFlags.RefreshView);

  if (shouldRefreshView) {
    refreshView(tView, lView, tView.template, lView[CONTEXT]);
  } else if (flags & LViewFlags.HasChildViewsToRefresh) {
    detectChangesInEmbeddedViews(lView, ChangeDetectionMode.Targeted);
    const components = tView.components;
    if (components !== null) {
      detectChangesInChildComponents(lView, components, ChangeDetectionMode.Targeted);
    }
  }
}

/** Refreshes child components in the current view (update mode). */
function detectChangesInChildComponents(
    hostLView: LView, components: number[], mode: ChangeDetectionMode): void {
  for (let i = 0; i < components.length; i++) {
    detectChangesInComponent(hostLView, components[i], mode);
  }
}
