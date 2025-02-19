using System;
using DCL.ECS7;
using DCL.ECS7.InternalComponents;
using DCL.ECSComponents;
using DCL.ECSRuntime;

namespace ECSSystems.InputSenderSystem
{
    public static class ECSInputSenderSystem
    {
        private class State
        {
            public IInternalECSComponent<InternalInputEventResults> inputResultComponent;
            public IECSComponentWriter componentWriter;
            public int lastTimestamp = 0;
        }

        public static Action CreateSystem(
            IInternalECSComponent<InternalInputEventResults> inputResultComponent,
            IECSComponentWriter componentWriter)
        {
            var state = new State()
            {
                inputResultComponent = inputResultComponent,
                componentWriter = componentWriter
            };
            return () => Update(state);
        }

        private static void Update(State state)
        {
            var inputResults = state.inputResultComponent.GetForAll();
            var writer = state.componentWriter;

            for (int i = 0; i < inputResults.Count; i++)
            {
                var model = inputResults[i].value.model;
                if (!model.dirty)
                    continue;

                var scene = inputResults[i].value.scene;
                var entity = inputResults[i].value.entity;
                // using foreach to iterate through queue without removing it elements
                // if it proves too slow we should switch the queue for a list
                foreach (InternalInputEventResults.EventData inputEvent in model.events)
                {
                    writer.AppendComponent(scene.sceneData.sceneNumber,
                        entity.entityId,
                        ComponentID.POINTER_EVENTS_RESULT,
                        new PBPointerEventsResult()
                        {
                            Button = inputEvent.button,
                            Hit = inputEvent.hit,
                            State = inputEvent.type,
                            Timestamp = state.lastTimestamp++
                        },
                        ECSComponentWriteType.SEND_TO_SCENE | ECSComponentWriteType.WRITE_STATE_LOCALLY);

                }
                model.events.Clear();
            }
        }
    }
}
