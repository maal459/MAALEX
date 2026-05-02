import React from 'react';
import {
  View,
  SafeAreaView,
  Text,
  StyleSheet,
  FlatList,
  Image,
  Dimensions,
} from 'react-native';
import {TouchableOpacity} from 'react-native-gesture-handler';
import COLORS from './colors';
import plants from './Plant';
import { APP_LOGO, APP_NAME } from './constants/appConfig';


const width = Dimensions.get('window').width / 2 - 30; // Adjusted width based on removal

const HomeScreen = ({navigation}) => {
  const Card = ({plant}) => {
    return (
      <TouchableOpacity
        activeOpacity={0.8}
        onPress={() => navigation.navigate(plant.targetScreen, {plant})}>
        <View style={style.card}>
          <View style={{alignItems: 'flex-end'}}>
           
          </View>

          <View style={{height: 80, alignItems: 'center'}}>
            <Image source={plant.img} style={{flex: 1, resizeMode: 'contain'}} />
          </View>

          <Text style={{fontWeight: 'bold', fontSize: 17, marginTop: 10, textAlign:'center'}}>
            {plant.name}
          </Text>
         
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={{flex: 1, paddingHorizontal: 10, backgroundColor: COLORS.white}}>
      <View style={style.header}>
        <TouchableOpacity style={style.brandHeader} onPress={() => navigation.navigate('About')}>
          <Image style={style.logo} source={APP_LOGO} />
          <Text style={style.brandName}>{APP_NAME}</Text>
        </TouchableOpacity>
      </View>
      <FlatList
        columnWrapperStyle={{justifyContent: 'space-between'}}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          marginTop: 10,
          paddingBottom: 10,
        }}
        numColumns={2}
        data={plants}
        renderItem={({item}) => <Card plant={item} />}


      />
       
    </SafeAreaView>
  );
};

const style = StyleSheet.create({
  card: {
    height: 150,
    backgroundColor: COLORS.light,
    
    marginHorizontal: 2,
    borderRadius: 10,
    marginBottom: 10,
    padding: 10,
  },
  logoContainer: {
    alignItems: 'center', // Centers the logo horizontally
    marginBottom: 10, // Adds some space at the bottom
  },
  logoImage: {
    width: 130, // Adjust the size as needed
    height: 50, // Adjust the size as needed
    resizeMode: 'contain', // Ensures the image aspect ratio is maintained
  },
  SloganText: { 
    fontSize: 10,
    color: '#ffffff',
    justifyContent: 'center',
    alignItems: 'center',
    textAlign: "center",
  },
  brandHeader: {
    alignItems: 'center',
    gap: 12,
  },
  logo: {
    height: 88,
    width: 88,
    marginTop: 20,
    resizeMode: 'contain',
  },
  brandName: {
    color: '#347dce',
    fontSize: 28,
    fontWeight: '700',
    letterSpacing: 2,
  },
  header: {
    marginTop: 10,
    flexDirection: 'row',
    justifyContent: 'center', // Align children horizontally to the center
    alignItems: 'center', // Align children vertically to the center (if your header's height is explicitly set or determined by its content)
    marginBottom: 20, // Optional: Add some bottom margin if needed
  },
});
export default HomeScreen;
