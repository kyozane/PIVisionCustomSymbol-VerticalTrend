// <copyright file="PIVisualization.sym-trend.js" company="OSIsoft, LLC">
// Copyright © 2015-2017 OSIsoft, LLC. All rights reserved.
// THIS SOFTWARE CONTAINS CONFIDENTIAL INFORMATION AND TRADE SECRETS OF OSIsoft, LLC.
// USE, DISCLOSURE, OR REPRODUCTION IS PROHIBITED WITHOUT THE PRIOR EXPRESS WRITTEN
// PERMISSION OF OSIsoft, LLC.
//
// RESTRICTED RIGHTS LEGEND
// Use, duplication, or disclosure by the Government is subject to restrictions
// as set forth in subparagraph (c)(1)(ii) of the Rights in Technical Data and
// Computer Software clause at DFARS 252.227.7013
//
// OSIsoft, LLC.
// 1600 Alvarado Street, San Leandro, CA 94577
// </copyright>

/// <reference path="../_references.js" />

window.PIVisualization = window.PIVisualization || {};

(function (PV) {
    'use strict';

    PV.TrendEnums = {
        ValueScaleType: Object.freeze({
            Autorange: 0,           // Adjust based on values in range
            Database: 1,            // Use min/max from AF or zero/span from PI data archive
            Absolute: 2             // Custom settings from MinValue and MaxValue
        }),
        TimeScaleType: Object.freeze({
            Full: 0,                // Start, end and duration
            Partial: 1,             // Partial timestamps for each tick
            Relative: 2,            // Offset from end of plot
            RelativeToStart: 3      // Offset from start of plot
        })
    };

    function trendVis() { }
    PV.deriveVisualizationFromBase(trendVis);

    trendVis.prototype.init = function (scope, elem, $rootScope, appData, cursorSync, dateTimeFormatter, timeProvider, trendZoomService, ecTrendConfig) {
        var that = this;

        // no need to bind() these callbacks
        this.onDataUpdate = dataUpdate;
        this.onDestroy = destroy;
        this.onResize = resize;
        this.onConfigChange = configChange;

        this.timeProvider = timeProvider;
        this.appData = appData;
        this.cursorSync = cursorSync;
        this.dateTimeFormatter = dateTimeFormatter;
        this.trendZoomService = trendZoomService;
        this.ecTrendConfig = ecTrendConfig;

        this.plotArea = elem.find('.plot-area-rect');
        this.gestureRoot = null;
        this.lastGoodPinchEvent = null;
        this.gestureTimeoutPromise = null;
        this.gestureInactivityTimeout = 750;
        this.currentGesture = null;
        this.tapTimeoutPromise = null;
        this.lastTapEvent = null;
        this.rootScope = $rootScope;

        scope.trendModel = new PV.SVGTrendModel(angular.equals, scope.position.width, scope.position.height, scope.config.TrendConfig);
        scope.cursor = new PV.SVGTrendCursor(scope.trendModel);

        // Default interaction options are read at startup, can be overridden by setting property on runtimeData
        var options = angular.merge({
            timeRangeChange: true, // includes "zoom", "pinch" and "pan" action changes to time
            cursor: true,
            highlightTraceOnLegendClick: true
        }, scope.runtimeData.options);

        scope.runtimeData.options = options;

        scope.runtimeData.setCursor = this.setCursor.bind(this);

        // Initialize trend legend with datasources
        if (scope.symbol.DataSources) {
            scope.symbol.DataSources.forEach(function (item) {
                item = item ? item.toString() : '';                         // Make sure it's a string
                var path = item;
                item = item.substr(item.lastIndexOf('\\') + 1) || item;     // strip out server and database
                item = item.substr(0, item.indexOf('?')) || item;           // remove ID after last '?'
                scope.trendModel.trendData.Traces.push({ Label: item, Path: path, Value: '...' });
            });
        }

        // Set legend width from persistence
        scope.trendModel.config.legend.width = scope.config.TrendConfig.LegendWidth;
        scope.legendResizer = new PV.TrendLegendResizer(legendResizeHandler.bind(this));

        scope.busy = false;
        scope.isTraceHidden = function (index) { return !!(scope.config && scope.config.TraceSettings && scope.config.TraceSettings[index] && scope.config.TraceSettings[index].Hidden); };

        // Color settings
        scope.bandingColor = PV.Utils.computeReverseColor(scope.config.BackgroundColor);
        scope.traceColor = function (palIndex) { return 'palette-' + palIndex; };
        scope.traceMarkerClass = function (trace) {
            if (scope.config.TraceSettings && scope.config.TraceSettings[trace.traceIndex] && scope.config.TraceSettings[trace.traceIndex].MarkerIndex != null) {
                return 'marker-' + scope.config.TraceSettings[trace.traceIndex].MarkerIndex;
            }
            return 'marker-' + trace.markerIndex;
        };
        scope.traceMarkerPath = function (trace) {
            if (scope.config.TraceSettings && scope.config.TraceSettings[trace.traceIndex] && scope.config.TraceSettings[trace.traceIndex].MarkerPath != null) {
                return scope.config.TraceSettings[trace.traceIndex].MarkerPath;
            }
            return trace.markerPath;
        };
        scope.traceClasses = function (trace) {
            var classes = [scope.traceColor(trace.palIndex)];
            if (trace.highlighted) {
                classes.push('highlighted');
            }
            return classes;
        };
        scope.traceProperty = function (property, index) {
            if (scope.config.TraceSettings && scope.config.TraceSettings[index]) {
                return scope.config.TraceSettings[index][property];
            }
        };
        scope.traceWidth = function (index) {
            // Fall back to CSS class for highlighting narrow lines, leave thicker lines alone to preserve detail
            var width = scope.traceProperty('StrokeWidth', index);
            return width <= 3 && scope.trendModel.highlightedIndex === index ? undefined : width;
        };
        scope.legendItemClass = function (index) {
            var classes = [];
            if (scope.isTraceHidden(index)) {
                classes.push('hidden-trace');
            }
            if (scope.isLegendItemSelected(index)) {
                classes.push('trend-legend-selected-item');
            }
            if (!!scope.bandingColor) {
                classes.push('light-theme');
            }
            if (!scope.layoutMode && scope.runtimeData.options && scope.runtimeData.options.highlightTraceOnLegendClick) {
                classes.push('hover-highlight');
            }
            return classes;
        };
        scope.onClickLegendItem = function (index) {
            if (scope.runtimeData.options.highlightTraceOnLegendClick && !scope.layoutMode && !scope.isTraceHidden(index)) {
                scope.trendModel.highlight(scope.trendModel.highlightedIndex === index ? null : index);
            }
        };
        scope.isLegendItemSelected = function (index) {
            // Return true if the context menu is active for the this legend item or if its trace is highlighted and the context menu is not active
            return scope.runtimeData.contextMenuIndex === index || (scope.trendModel.highlightedIndex === index && scope.runtimeData.contextMenuIndex === undefined);
        };

        scope.lastConfigChangeDisplayTime = null;

        scope.onMouseMove = onMouseMove.bind(this);
        scope.onMouseEnter = onMouseEnter.bind(this);
        scope.onMouseLeave = onMouseLeave.bind(this);
        scope.onMouseUp = onMouseUp.bind(this);
        scope.gesturing = false;

        scope.rubberBandLeft = function () { return trendZoomService.rubberBand.left + scope.trendModel.plotLeft(); };
        scope.rubberBandTop = function () { return trendZoomService.rubberBand.top + scope.trendModel.plotTop(); };
        scope.rubberBandWidth = function () { return trendZoomService.rubberBand.width; };
        scope.rubberBandHeight = function () { return trendZoomService.rubberBand.height; };
        scope.zooming = function () { return trendZoomService.currentTrend === scope.symbol.Name; };

        this.onRubberbandZoomComplete = onRubberbandZoomComplete.bind(this);
        trendZoomService.onRubberbandZoomComplete.subscribe(this.onRubberbandZoomComplete);

        this.revertZoom = function () { delete that.scope.config.Zoom; };
        timeProvider.onDisplayTimeChanged.subscribe(this.revertZoom);

        scope.beginSplitterMove = beginSplitterMove.bind(this);

        var trendRoot = elem.find('.trend-container');
        trendRoot.on('touchstart', onSymbolTouchStart.bind(this));
        trendRoot.on('touchmove', onSymbolTouchMove.bind(this));
        trendRoot.on('touchend', onSymbolTouchEnd.bind(this));

        Object.defineProperty(scope, 'panning', { get: function () { return that.currentGesture === 'panning'; } });

        this.gestureRoot = elem.find('.trend-gesture-root');

        // We must force hammer to listen for touch and mouse events under unit tests
        // otherwise we cannot test touch handlers on browsers running on non-touch devices.
        // Hammer will feature detect touch support and not listen for those events. This happens
        // when the script loads so we cannot trick this detection by, for example, adding
        // ontouchmove() to the window object. It also seeme impossible to get the hammer manager (mc)
        // in the tests to reset the input class.
        var inputClass = PV.isUnitTesting ? Hammer.TouchMouseInput : null;

        var mc = new Hammer(
            this.gestureRoot[0],
            {
                domEvents: false,
                recognizers: [
                    [Hammer.Tap, { interval: 0, taps: 1, threshold: 10 }],
                    [Hammer.Pan, { enable: true, direction: Hammer.DIRECTION_HORIZONTAL }],
                    [Hammer.Pinch]
                ],
                inputClass: inputClass
            }
        );

        if (options.cursor) {
            mc.on('tap', onTap.bind(this));
        }

        if (options.timeRangeChange) {
            mc.on('panstart', onPanStart.bind(this));
            mc.on('pan', onPan.bind(this));
            mc.on('panend', onPanEnd.bind(this));
            mc.on('pinchstart', onPinchStart.bind(this));
            mc.on('pinchcancel', onPinchCancel.bind(this));
            mc.on('pinch', onPinch.bind(this));
            mc.on('pinchend', onPinchEnd.bind(this));
        }

        if (options.cursor && !options.timeRangeChange) {
            mc.on('panstart', onPanStart.bind(this));
            mc.on('pan', onPan.bind(this));
            mc.on('panend', onPanEnd.bind(this));
        }

        this.onTimeRangeGesture = onTimeRangeGesture.bind(this);
        timeProvider.onGesture.subscribe(this.onTimeRangeGesture);

        //
        // Update after datasources are reordered or deleted
        //
        scope.$watch('symbol.DataSources', function (nv, ov) {
            if (nv && ov && !angular.equals(nv, ov)) {
                scope.trendModel.highlight(null);
                that.revertZoom();
                if (nv.length < ov.length ||    // datasources deleted
                    ((nv.length === ov.length) && ov.some(function (ds, idx) { return nv.indexOf(ds) > -1 && ds !== nv[idx]; }))) { // datasources reordered
                    scope.$emit(scope.cursor.callouts.length ? 'refreshDataforChangedSymbolsWithCursor' : 'refreshDataForChangedSymbols');
                    scope.trendModel.refresh();
                }
            }
        }, true);

        scope.$on('highlightTrace', onHighlightTrace.bind(this));
        scope.$on('setTrendCursors', onSetCursor.bind(this));
        scope.$on('setTraceMetadata', onSetTraceMetadata.bind(this));

        scope.$on('setLayoutModeEvent', function () { scope.trendModel.highlight(null); });

        if (ecTrendConfig.traceMetadata && ecTrendConfig.traceMetadata.length > 0) {
            scope.$emit('setTraceMetadata');
        }
    };

    function valueScaleSettings(config) {
        return (config.TraceSettings || [])
            .filter(function (traceSetting) {
                return traceSetting && !!traceSetting.ValueScaleSetting;
            }).map(function(traceSetting) { 
                return traceSetting.ValueScaleSetting;
            });
    }

    function hiddenTracesCount(config) {
        return (config.TraceSettings || [])
            .filter(function (traceSetting) {
                return traceSetting && traceSetting.Hidden;
            }).length;
    }

    function onHighlightTrace(e, index) {
        this.scope.trendModel.highlight(index);
    }

    function onSetCursor(e, date) {
        this.setCursor(date);
    }

    function onSetTraceMetadata(e) {
        if (!this.scope.config.TraceSettings) {
            this.scope.config.TraceSettings = [];
        }

        if (this.ecTrendConfig.traceMetadata) {
            this.ecTrendConfig.traceMetadata.forEach(function (item) {
                var index = item.traceIndex,
                    color = item.traceColor,
                    markerIndex = item.markerIndex,
                    markerPath = PV.Markers.getMarker(markerIndex);

                if (this.scope.config.TraceSettings[index]) {
                    this.scope.config.TraceSettings[index].Color = color;
                    this.scope.config.TraceSettings[index].MarkerIndex = markerIndex;
                    this.scope.config.TraceSettings[index].MarkerPath = markerPath;
                } else {
                    this.scope.config.TraceSettings[index] = {
                        Color: color,
                        MarkerIndex: markerIndex,
                        MarkerPath: markerPath
                    };
                }
            }, this);        
        }
    }

    // Called from symbol host if anything in the config changes
    function configChange(newConfig, oldConfig) {
        if (!newConfig || !oldConfig || angular.equals(newConfig, oldConfig)) {
            return;
        }

        var dataRequest;
        var requestTypes = {
            changed: 'refreshDataForChangedSymbols',
            cursor: 'refreshDataforChangedSymbolsWithCursor',
            all: 'refreshDataForAllSymbols'
        };

        if (newConfig.BackgroundColor !== oldConfig.BackgroundColor) {
            this.scope.bandingColor = PV.Utils.computeReverseColor(newConfig.BackgroundColor);
        }

        var hiddenTracesChange = hiddenTracesCount(newConfig) - hiddenTracesCount(oldConfig);
        if (hiddenTracesChange !== 0) {
            dataRequest = requestTypes.changed;

        } else if (!angular.equals(newConfig.ValueScaleSetting, oldConfig.ValueScaleSetting) || !angular.equals(valueScaleSettings(newConfig), valueScaleSettings(oldConfig))) {
            // Trend scale type changed
            dataRequest = requestTypes.changed;

        } else if (this.trendZoomService.lastDisplayTimeZoomed && this.timeProvider.displayTime && !angular.equals(this.trendZoomService.lastDisplayTimeZoomed, this.timeProvider.displayTime)) {
            // time range scroll?
            dataRequest = requestTypes.all;

        } else if (newConfig.MultipleScales !== oldConfig.MultipleScales) {
            dataRequest = requestTypes.changed;
        } 

        // Remove highlighted traces after any config change other than zooming, legend width changes
        if (this.scope.trendModel.highlightedIndex >= 0
                    && angular.equals(newConfig.Zoom, oldConfig.Zoom)
                    && angular.equals(newConfig.TrendConfig.LegendWidth, oldConfig.TrendConfig.LegendWidth)) {
            this.scope.trendModel.highlight(null);
        }

        if (newConfig.TrendConfig.legend
                    && oldConfig.TrendConfig.legend
                    && newConfig.TrendConfig.legend.shown !== oldConfig.TrendConfig.legend.shown) {
            this.scope.trendModel.config.legend.shown = newConfig.TrendConfig.legend.shown;
            this.scope.trendModel.refresh();
        }

        if (dataRequest) {
            if (dataRequest === requestTypes.changed && this.cursorSync.date) {
                dataRequest = requestTypes.cursor;
            }
            this.scope.$emit(dataRequest);
        }
    }

    // Called by symbol host when this.scope is destroyed
    function destroy() {
        this.trendZoomService.onRubberbandZoomComplete.unsubscribe(this.onRubberbandZoomComplete);
        this.timeProvider.onDisplayTimeChanged.unsubscribe(this.revertZoom);
        this.timeProvider.onGesture.unsubscribe(this.onTimeRangeGesture);
    }

    function resize(width, height) {
        if (this.scope.trendModel) {
            this.scope.trendModel.setDimensions(width, height);
        }
    }

    function dataUpdate(newVal) {
        if (newVal) {
            // we're definitely done gesturing when a data update arrives
            this.scope.gesturing = false;

            this.scope.legendResizer.update(this.scope.config.TrendConfig.LegendWidth);   //  Required to reset the legendWidth on undo/redo of legend resize.
            this.scope.trendModel.update(newVal);

            if (this.cursorSync.isPersisted && newVal.CursorTime === undefined && newVal.CursorOffset === undefined) {
                this.cursorSync.isPersisted = false;
            } else if (this.scope.cursor.update(newVal)) {
                this.cursorSync.reset();
            }
        }
    }

    function beginSplitterMove(event) {
        this.scope.legendResizer.onLegendResizeStart(event);
    }

    function onMouseMove(event) {
        this.scope.legendResizer.onLegendResizeMove(event, this.scope.position.width);
    }

    function onMouseUp(event) {
        this.scope.legendResizer.onLegendResizeEnd(event);
    }

    function onMouseEnter(event) {
        this.scope.legendResizer.onLegendResizeEnter(event);
    }

    function onMouseLeave(event) {
        this.scope.legendResizer.onLegendResizeEnter(event);
    }

    //
    // Gesture functionality
    //

    function onTap(e) {

        // Hammer has a bug with taps on windows touch devices where it sends 2 taps for each actual
        // touch and release. We can work around thios issues by ignoring taps that occur in the exact 
        // same location as the last and at almost the same time. The extra tap also is reported as a 
        // mouse event (the 1st was a touch) so that also helps in detection of these phantom taps.
        // Hammer issue: https://github.com/hammerjs/hammer.js/issues/917 and
        // Possible fix: https://github.com/kara/hammer.js/commit/52d1debd8782cce6348518d298b5f698b60dfc3f
        if (e && this.lastTapEvent &&
            this.lastTapEvent.pointerType !== e.pointerType &&
            this.lastTapEvent.changedPointers[0].clientX === e.changedPointers[0].clientX &&
            this.lastTapEvent.changedPointers[0].clientY === e.changedPointers[0].clientY &&
            e.timeStamp - this.lastTapEvent.timeStamp < 1000) {
            return;
        }

        var that = this;
        if (this.tapTimeoutPromise) {
            this.timeout.cancel(this.tapTimeoutPromise);
            this.tapTimeoutPromise = null;
            this.scope.$emit('expandSymbol', { symbolName: this.scope.runtimeData.name });
        } else {
            if (!this.scope.busy && !this.scope.layoutMode && !this.scope.gesturing) {
                this.tapTimeoutPromise = this.timeout(function () {
                    that.addCursorAfterDelay(e);
                }, 300);
            }
        }

        this.lastTapEvent = e;
    }

    trendVis.prototype.addCursorAfterDelay = function (e) {
        this.addCursor(this.screenToClientPoint(e).x);
        this.tapTimeoutPromise = null;
    };

    trendVis.prototype.getGestureTargetArea = function (e) {
        // Can not use e.target for the target - see bug https://github.com/hammerjs/hammer.js/issues/815
        // Using elementFromPoint work around to get the target.
        var target = document.elementFromPoint(e.pointers[0].pageX - e.deltaX, e.pointers[0].pageY - e.deltaY);
        var gestTarg = $(target).closest('.trend-gesture-target', this.gestureRoot);

        if (!gestTarg || gestTarg.length !== 1)
            return null;

        if (gestTarg.hasClass('trend-cursor'))
            return 'cursor';
        else if (gestTarg.hasClass('trend-pan-area'))
            return 'pan';
        else
            return 'plot';
    };

    function onPanStart(e) {
        // don't allow for new gestures while still waiting for data from a previous gesture or layout mode 
        if (this.scope.busy || this.scope.layoutMode || this.scope.trendModel.isSparkline)
            return;

        this.currentGesture = null;
        this.lastGoodPinchEvent = null;

        var gestArea = this.getGestureTargetArea(e);
        var pt;
        if (gestArea === 'cursor') {

            // The cursor code expects to have its start() called on a mousedown/touchstart event
            // but we no longer handle those events directly. We can simulate this on our
            // 1st move event but adjusting the x location by the distance moved. It seems
            // like the cursor code could be refactored to do away with this, but this hasn't 
            // been done as of yet.
            pt = this.screenToClientPoint(e);
            this.startMoveCursor(pt.x - e.deltaX);
            this.moveCursor(pt.x);
        } else if (this.runtime.options.timeRangeChange) {
            if (gestArea === 'pan' || e.pointerType === 'touch') {
                this.currentGesture = 'panning';
            } else {
                pt = this.screenToClientPoint(e);
                pt.x = pt.x - e.deltaX;
                pt.y = pt.y - e.deltaY;
                this.trendZoomService.startRubberBandZoom(this.scope.symbol.Name, pt, this.scope.trendModel.plotWidth(), this.scope.trendModel.plotHeight());
                this.timeProvider.startRubberbandZoom();
            }
        }
    }

    function onPan(e) {
        if (this.scope.busy || this.scope.layoutMode)
            return;

        if (this.scope.cursor.eventStart) {
            this.moveCursor(this.screenToClientPoint(e).x);
        } else if (this.currentGesture === 'panning') {
            this.timeProvider.panTimeRange(this.scope.trendModel.calcXOffsetPercent(e.deltaX) / this.appData.zoomLevel);
        } else if (this.trendZoomService.currentTrend) {
            this.trendZoomService.createRubberBand(this.screenToClientPoint(e));
        }
    }

    function onPinchStart(e) {
        this.lastGoodPinchEvent = null;
    }

    function onPinch(e) {
        if (this.scope.busy || this.scope.layoutMode)
            return;
        
        // see onPinchCancel
        if (e.scale !== 1)
            this.lastGoodPinchEvent = e;

        this.currentGesture = 'pinching';
        var x = this.screenToClientPoint(e).x;
        this.timeProvider.scaleTimeRange(e.scale, this.scope.trendModel.calcXOffsetPercent(x) / this.appData.zoomLevel);
    }

    function onPinchEnd(e) {
        if (this.scope.busy || this.scope.layoutMode)
            return;

        this.gestureComplete();
    }

    // iOS seems to cancel our pinch events at random when we stop pinching, it will go so far
    // as to send a finial pan event that resets any panning done previosuly. To work around this
    // we'll keep the last event that actually changed the scale and use it change the zoom of
    // the trend in the cancel message
    function onPinchCancel() {
        if (this.scope.busy || this.scope.layoutMode)
            return;
            
        onPinch.bind(this)(this.lastGoodPinchEvent);
        this.gestureComplete();
    }

    function onPanEnd(e) {
        if (this.scope.busy || this.scope.layoutMode)
            return;

        if (this.currentGesture) {
            this.gestureComplete();
        } else if (this.trendZoomService.currentTrend) {
            this.zoomTrend(this.screenToClientPoint(e));
        } else if (!this.scope.gesturing) {
            // handle cursors
            if (this.scope.cursor.eventStart) {
                // we must have been moving a cursor if this is set
                this.stopMoveCursor(this.screenToClientPoint(e).x);
            }
        }
    }

    trendVis.prototype.gestureComplete = function () {
        // tell the timeprovider we're done one gesture, but don't fire a data update yet
        this.timeProvider.gestureComplete(false);

        // start waiting to detect inactivity
        if (this.gestureTimeoutPromise)
            this.timeout.cancel(this.gestureTimeoutPromise);

        var that = this;
        this.gestureTimeoutPromise = this.timeout(function () {
            that.timeProvider.gestureComplete(true);
        }, this.gestureInactivityTimeout);

        this.currentGesture = null;
    };

    trendVis.prototype.screenToClientPoint = function (e) {
        var rect = this.plotArea[0].getBoundingClientRect();

        // hammer seems to round points, so we should as well
        return {
            x: e.center.x - Math.round(rect.left) - this.scope.trendModel.plotLeft(),
            y: e.center.y - Math.round(rect.top) - this.scope.trendModel.plotTop()
        };
    };

    // Handler from the time provider signal. This routine will be called for all trends on the display
    // even if that trend isn't the one being panned and will actually apply the pan or pinch to the traces
    // while gesturing is taking place
    function onTimeRangeGesture(startLabel, endLabel, gesture) {

        if (gesture.cancel) {
            this.scope.gesturing = false;
        } else {
            this.scope.gesturing = true;

            // todo: this is a hacky way to remove the cursor, we should have a cursor.remove() call or something
            if (this.scope.cursor.pos > this.scope.trendModel.plotLeft())
                this.scope.cursor.update({});

            // stop the gesture timeout on this trend if we started gesturing on another symbol, that symbol will now
            // handle the final application of the time change
            this.cancelPendingGestureTimeout();

            if (gesture.type === 'panning')
                this.scope.trendModel.pan(gesture.percent, startLabel, endLabel);
            else
                this.scope.trendModel.scale(gesture.scale, gesture.offset, startLabel, endLabel);
        }
    }

    trendVis.prototype.cancelPendingGestureTimeout = function () {
        if (this.gestureTimeoutPromise) {
            this.timeout.cancel(this.gestureTimeoutPromise);
            this.gestureTimeoutPromise = null;
        }
    };

    //
    // Rubber-Band Zooming
    //

    trendVis.prototype.zoomTrend = function (currLoc) {
        var limits = this.scope.trendModel.getValueScaleLimits();
        if (this.trendZoomService.rubberBand.height <= 1 || this.trendZoomService.rubberBand.width <= 1 || !limits) {
            this.trendZoomService.zoomComplete();
            return;
        }

        var that = this;
        var zoom = this.scope.config.Zoom = {};

        // if limits.min is set then proceed setting a single scale, otherwise set scales for individual traces
        // Scale limit types: 0 = Autorange, 1 = Database, 2 = Absolute
        // If absolute, MinValue = scale lower limit, MaxValue = scale upper limit        
        if (limits.min !== null) {
            zoom.ValueScaleSetting = this.zoomedScaleSetting(limits.min, limits.max);
        } else {
            zoom.TraceSettings = limits.traces.map(function (limits) {
                return { ValueScaleSetting: that.zoomedScaleSetting(limits.min, limits.max) };
            });
            zoom.ValueScaleSetting = {
                MinType: PV.TrendEnums.ValueScaleType.Absolute,
                MaxType: PV.TrendEnums.ValueScaleType.Absolute
            };
        }

        // deteremine the new start and end time
        var startPercent = this.scope.trendModel.calcXOffsetPercent(this.trendZoomService.rubberBand.left);
        var endPercent = this.scope.trendModel.calcXOffsetPercent((this.trendZoomService.rubberBand.left + this.trendZoomService.rubberBand.width));

        this.timeProvider.setZoomedTimeRange(startPercent, endPercent);

        this.scope.busy = true;
        this.scope.$emit('updateZoomedTrend', function () {
            that.trendZoomService.zoomComplete();
            that.scope.busy = false;
        });

        this.trendZoomService.lastDisplayTimeZoomed = this.timeProvider.displayTime;
    };

    // determine the new scale max and min based on rubberBand dimensions
    trendVis.prototype.zoomedScaleSetting = function (scaleMin, scaleMax) {
        var plotRange = this.scope.trendModel.plotHeight();
        var scaleRange = scaleMax - scaleMin;
        var min = (1 - ((this.trendZoomService.rubberBand.top + this.trendZoomService.rubberBand.height) / plotRange)) * scaleRange + scaleMin;
        var max = (1 - (this.trendZoomService.rubberBand.top / plotRange)) * scaleRange + scaleMin;
        var limits = adjustLimits(min, max);
        return {
            MinType: PV.TrendEnums.ValueScaleType.Absolute,
            MinValue: limits.min,
            MaxType: PV.TrendEnums.ValueScaleType.Absolute,
            MaxValue: limits.max
        };
    };

    // round limits for significant digits
    function adjustLimits(min, max) {
        var delta = max - min;
        if (delta > 0) {
            var tooSmall = 1e-14; // Practical limit of floating point rounding
            if (delta < tooSmall) {
                max = min + tooSmall;
            } else if (delta > 100) {
                min = Math.floor(min);
                max = Math.ceil(max);
            } else {
                var log10delta = Math.floor(Math.log(delta) / Math.LN10);
                var precision = Math.abs(log10delta - 2);
                var pow10 = Math.pow(10, precision);
                min = Math.round(min * pow10) / pow10;
                max = Math.round(max * pow10) / pow10;
            }
        }
        return { min: min, max: max };
    }

    function onRubberbandZoomComplete() {
        if (this.cursorSync.date) {
            this.setCursor(this.cursorSync.date);
        }
    }

    //
    // Cursor functionality
    //
    trendVis.prototype.addCursor = function (x) {
        if (this.scope.trendModel.timeScale.height <= 0)
            return;

        var cursorDate = this.getCursorDate(x / this.appData.zoomLevel, this.scope.trendModel);
        if (cursorDate) {
            this.rootScope.$broadcast('setTrendCursors', cursorDate);
            this.scope.$emit('updateTrendCursors', cursorDate);
        }
        this.scope.pointerUpIsNotADrop = true;

    };

    trendVis.prototype.startMoveCursor = function (x) {
        this.scope.cursor.eventStart = {
            startX: x,
            pos: this.scope.cursor.pos
        };
    };

    trendVis.prototype.moveCursor = function (x) {
        if (this.scope.cursor.eventStart) {
            var cursorDate = this.getCursorDate(x / this.appData.zoomLevel, this.scope.trendModel);
            this.rootScope.$broadcast('setTrendCursors', cursorDate);
            return cursorDate;
        }
    };

    trendVis.prototype.stopMoveCursor = function (x) {
        if (this.scope.cursor.eventStart) {
            var cursorDate = this.moveCursor(x);
            if (cursorDate) {
                this.scope.$emit('updateTrendCursors', cursorDate);
                delete this.scope.cursor.eventStart;
            }
        }
    };

    trendVis.prototype.setCursor = function (cursorDate) {
        this.scope.runtimeData.allowCursor = this.scope.trendModel.timeScale.height > 0;

        if (cursorDate && this.scope.runtimeData.allowCursor) {
            var pos = this.getCursorPos(cursorDate, this.scope.trendModel);
            this.scope.cursor.setPosition(pos);

            if (this.scope.runtimeData.relative) {
                this.scope.cursor.time = this.dateTimeFormatter.formatDurationNumber(cursorDate - this.scope.trendModel.relativeTimeZero);
            } else {                
                var duration  = Date.parse(this.timeProvider.getServerEndTime()) - Date.parse(this.timeProvider.getServerStartTime());
                this.scope.cursor.time = this.dateTimeFormatter.formatDateTime(cursorDate, duration <= 5000.0);
            }
        } else {
            this.scope.cursor.setPosition(0);
        }

        if (!(this.scope.cursor.pos === 0 && this.scope.runtimeData.allowCursor)) {
            this.scope.trendModel.nowline = -1;
            this.scope.trendModel.trendData.NowPosition = undefined;
        }

        if (this.scope.cursor.eventStart && this.scope.cursor.pos === 0) {
            delete this.scope.cursor.eventStart;
            if (!this.scope.runtimeData.relative && this.cursorSync.wasUpdating && Date.parse(this.timeProvider.getServerEndTime()) > Date.now()) {
                // Relative future end time, request new formatted times
                var newDates = this.timeProvider.model.reset(new Date(this.timeProvider.getServerStartTime()), new Date(this.timeProvider.getServerEndTime()));
                this.timeProvider.requestNewTime(newDates.start, newDates.end, true, true);
            } else if (this.scope.runtimeData.relative){
                this.scope.$emit('updateTrendCursors');
            }
            this.cursorSync.reset();
            return true;
        }
    };

    trendVis.prototype.getCursorPos = function (cursorDate, trendModel) {
        if (this.scope.runtimeData.relative) {
            return Math.ceil(trendModel.calcXPosition(cursorDate));
        } else {
            var start = Date.parse(this.timeProvider.getServerStartTime()),
                end = Date.parse(this.timeProvider.getServerEndTime()),
                cursorMs = cursorDate.getTime(),
                offset = (cursorMs - start) / (end - start),
                pos = (trendModel.plotWidth() * offset) + trendModel.plotLeft();

                return Math.ceil(pos);
        }
    };

    trendVis.prototype.getCursorDate = function (offsetX, trendModel) {
        if (this.scope.runtimeData.relative) {
            return trendModel.calcRelativeOffset(offsetX);
        } else {
            var start = Date.parse(this.timeProvider.getServerStartTime()),
                end = Date.parse(this.timeProvider.getServerEndTime()),
                percent = offsetX / trendModel.plotWidth(),
                cursorMs = start + ((end - start) * percent),
                cursorDate = new Date(cursorMs);

            if (cursorMs >= start && cursorMs <= end) {
                return cursorDate;
            }            
        }
    };

    //
    // Legend resize functionality
    //
    function legendResizeHandler(width, isFinal) {
        var legendConfig = this.scope.trendModel.config.legend;
        if (width === undefined) {
            return legendConfig.width;
        }
        if (isFinal) {
            // Persist the new width in the *symbol's* copy of the TrendConfig
            // which is seperate then the trendModel's config property
            this.scope.config.TrendConfig.LegendWidth = width;
        } else if (width != legendConfig.width) {
            legendConfig.width = width;
            this.scope.trendModel.refresh();
            this.scope.cursor.resize();
        }
    }

    function onSymbolTouchStart(event) {
        this.scope.legendResizer.onLegendResizeStart(event);
        this.scope.$digest();
    }

    function onSymbolTouchMove(event) {
        var handled = this.scope.legendResizer.onLegendResizeMove(event, this.scope.position.width);

        // in non-layout mode eat all touch move message, but not when legend scrollbars are shown
        if (!this.scope.layoutMode && !handled && !this.scope.legendResizer.showScrollbars) {
            event.stopPropagation();
            event.preventDefault();
        }

        this.scope.$digest();
    }

    function onSymbolTouchEnd(event) {
        this.scope.legendResizer.onLegendResizeEnd(event);
        this.scope.$digest();
    }

    function loadConfig(config) {
        // CS 3.0 Beta - flag was missing, server defaults to single scale
        if (config.MultipleScales === undefined) {
            config.MultipleScales = false;
        }

        //v 3.0 2016 - deprecated settings
        delete config.HiddenTraceIndexes;
        if (config.LastValueScaleSetting || config.LastTraceSettings) {
            // Persisted zoom
            config.Zoom = {
                ValueScaleSetting: config.LastValueScaleSetting,
                TraceSettings: config.LastTraceSettings
            };
            delete config.LastValueScaleSetting;
            delete config.LastTraceSettings;
        }

        // v 3.2 2017 and earlier - make stroke width numeric, round to nearest step
        if (config.TraceSettings) {
            config.TraceSettings.forEach(function (setting) {
                if (setting && setting.StrokeWidth) {
                    setting.StrokeWidth = PV.symbolCatalog.adjustSliderProperty(setting.StrokeWidth, 0.50);
                }
            });
        }

        return true; // Merge with getDefaultConfig
    }

    function getDefaultConfig () {
        return {
            DataShape: 'Trend',
            Height: 250,
            Width: 600,
            TrendConfig: {
                valueScale: {
                    axis: false,
                    tickMarks: true,
                    bands: true,
                    padding: 2
                },
                timeScale: {
                    axis: true,
                    tickMarks: true
                },
                padding: 2,
                nowPosition: true,
                LegendWidth: 120
            },
            MultipleScales: true,
            ValueScaleSetting: {
                MinType: PV.TrendEnums.ValueScaleType.Autorange,
                MaxType: PV.TrendEnums.ValueScaleType.Autorange
            },
            TimeScaleType: PV.TrendEnums.TimeScaleType.Full,
            NowPosition: true,
            TraceSettings: null
        };
    }

    function isolateDirtyDisplayProperties(config) {
        if (config) {
            delete config.Zoom;
        }
    }

    var def = {
        visObjectType: trendVis,
        typeName: 'Verticaltrend',
        displayName: PV.ResourceStrings.TrendSymbol,
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Multiple,
        iconUrl: 'Images/chrome.verticaltrend.svg',
        loadConfig: loadConfig,
        getDefaultConfig: getDefaultConfig,
        themes: {
            reverse: {
                TextColor: 'black',
                BackgroundColor: '#f0f0f0'
            }
        },
        isolateDirtyDisplayProperties: isolateDirtyDisplayProperties,
        templateUrl: 'scripts/app/editor/symbols/ext/sym-verticaltrend-template.html',
        inject: ['$rootScope', 'appData', 'cursorSync', 'dateTimeFormatter', 'timeProvider', 'trendZoomService', 'ecTrendConfig'],
        noExpandSelector: '.trend-gesture-root',
        supportsCollections: true,

        configTemplateUrl: 'scripts/app/editor/symbols/ext/sym-verticaltrend-config.html',
        configOptions: PV.TrendConfig.contextMenuOptions,
        contextMenuClose: PV.TrendConfig.contextMenuClose,
        configInit: PV.TrendConfig.init,
        configure: PV.TrendConfig.configure,
        dataSourcesAdded: PV.TrendConfig.configure.addTraces
    };

    PV.symbolCatalog.register(def);

})(window.PIVisualization);
