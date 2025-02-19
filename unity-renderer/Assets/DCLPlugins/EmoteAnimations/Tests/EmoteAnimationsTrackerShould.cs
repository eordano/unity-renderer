using System.Threading;
using AvatarSystem;
using Cysharp.Threading.Tasks;
using DCLServices.WearablesCatalogService;
using NSubstitute;
using NUnit.Framework;
using System.Collections;
using UnityEngine;
using UnityEngine.TestTools;

namespace DCL.Emotes
{
    public class EmoteAnimationsTrackerShould
    {
        private EmoteAnimationsTracker tracker;
        private DataStore_Emotes dataStore;
        private EmoteAnimationLoaderFactory loaderFactory;
        private IWearableItemResolver resolver;
        private IEmotesCatalogService emoteCatalog;
        private IWearablesCatalogService wearablesCatalogService;


        [SetUp]
        public void SetUp()
        {
            wearablesCatalogService = Substitute.For<IWearablesCatalogService>();
            dataStore = new DataStore_Emotes();
            loaderFactory = Substitute.ForPartsOf<EmoteAnimationLoaderFactory>();
            loaderFactory.Get().Returns(Substitute.For<IEmoteAnimationLoader>());
            resolver = Substitute.For<IWearableItemResolver>();

            emoteCatalog = Substitute.For<IEmotesCatalogService>();
            emoteCatalog.GetEmbeddedEmotes().Returns(GetEmbeddedEmotesSO());

            tracker = new EmoteAnimationsTracker(dataStore, loaderFactory, emoteCatalog, wearablesCatalogService);
        }

        private async UniTask<EmbeddedEmotesSO> GetEmbeddedEmotesSO()
        {
            EmbeddedEmotesSO embeddedEmotes = ScriptableObject.CreateInstance<EmbeddedEmotesSO>();
            embeddedEmotes.emotes = new EmbeddedEmote [] { };
            return embeddedEmotes;
        }


        [UnityTest]
        public IEnumerator InitializeEmbeddedEmotesOnConstructor()
        {
            UniTask<EmbeddedEmotesSO>.Awaiter embeddedEmotesTask = GetEmbeddedEmotesSO().GetAwaiter();
            yield return new WaitUntil(() => embeddedEmotesTask.IsCompleted);
            EmbeddedEmotesSO embeddedEmotesSo = embeddedEmotesTask.GetResult();
            foreach (EmbeddedEmote emote in embeddedEmotesSo.emotes)
            {
                Assert.AreEqual(dataStore.animations[(WearableLiterals.BodyShapes.FEMALE, emote.id)]?.clip, emote.femaleAnimation);
                Assert.AreEqual(dataStore.animations[(WearableLiterals.BodyShapes.MALE, emote.id)]?.clip, emote.maleAnimation);
                Assert.IsTrue(tracker.loaders.ContainsKey((WearableLiterals.BodyShapes.MALE, emote.id)));
            }
            wearablesCatalogService.Received(1).EmbedWearables(Arg.Any<WearableItem[]>());
        }


        [Test]
        [Category("Explicit")]
        [Explicit]
        public void ReactToEquipEmotesIncreasingReference()
        {
            string bodyShapeId = WearableLiterals.BodyShapes.FEMALE;

            AnimationClip tikAnim = Resources.Load<AnimationClip>("tik");
            WearableItem emote = new WearableItem { id = "emote0" };
            resolver.Resolve("emote0", Arg.Any<CancellationToken>()).Returns(new UniTask<WearableItem>(emote));
            IEmoteAnimationLoader loader = Substitute.For<IEmoteAnimationLoader>();
            loader.loadedAnimationClip.Returns(tikAnim);
            loaderFactory.Get().Returns(loader);

            dataStore.emotesOnUse.IncreaseRefCount((bodyShapeId, "emote0"));

            loaderFactory.Received().Get();
            resolver.Received().Resolve("emote0", Arg.Any<CancellationToken>());
            loader.Received().LoadEmote(tracker.animationsModelsContainer, emote, bodyShapeId, Arg.Any<CancellationToken>());
            var animKey = (bodyShapeId, "emote0");
            var animClip = dataStore.animations[animKey]?.clip;
            Assert.AreEqual(tikAnim, animClip);
        }

        [Test]
        public void ReactToEquipEmotesIncreasingReferenceWithExistentLoader()
        {
            loaderFactory.ClearReceivedCalls();
            tracker.loaders.Add((WearableLiterals.BodyShapes.FEMALE, "emote0"), Substitute.For<IEmoteAnimationLoader>());

            dataStore.emotesOnUse.IncreaseRefCount((WearableLiterals.BodyShapes.FEMALE, "emote0"));

            resolver.DidNotReceive().Resolve("emote0", Arg.Any<CancellationToken>());
            loaderFactory.DidNotReceive().Get();
        }

        [Test]
        public void ReactToEquipEmotesReferenceSetTo0()
        {
            string bodyshapeId = WearableLiterals.BodyShapes.FEMALE;
            var tikAnim = Resources.Load<AnimationClip>("tik");
            dataStore.animations.Add((bodyshapeId, "emote0"), new EmoteClipData(tikAnim));
            IEmoteAnimationLoader loader = Substitute.For<IEmoteAnimationLoader>();
            tracker.loaders.Add((bodyshapeId, "emote0"), loader);

            dataStore.emotesOnUse.SetRefCount((bodyshapeId, "emote0"), 0);

            Assert.IsFalse(tracker.loaders.ContainsKey((bodyshapeId, "emote0")));
            loader.Received().Dispose();
            Assert.IsFalse(dataStore.animations.ContainsKey((bodyshapeId, "emote0")));
        }
    }
}
